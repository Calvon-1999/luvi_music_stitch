const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Ensure temp directories exist
const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

// Create output directory
async function ensureDirectories() {
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
    } catch (error) {
        console.log('Directories already exist or error creating:', error.message);
    }
}

// Download file from URL
async function downloadFile(url, filepath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Trim audio to 1 minute
async function trimAudio(inputPath, outputPath, duration = 60) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .on('end', () => {
                console.log('Audio trimming completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Audio trimming error:', err);
                reject(err);
            })
            .run();
    });
}

// Get video duration
async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const duration = metadata.format.duration;
                resolve(duration);
            }
        });
    });
}

// Stitch videos together
async function stitchVideos(videoPaths, outputPath) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg();
        
        // Add all video inputs
        videoPaths.forEach(videoPath => {
            command.input(videoPath);
        });

        // Create filter complex for concatenation
        const filterComplex = videoPaths.map((_, index) => `[${index}:v][${index}:a]`).join('') + 
                             `concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;

        command
            .complexFilter(filterComplex)
            .outputOptions(['-map', '[outv]', '-map', '[outa]'])
            .output(outputPath)
            .on('end', () => {
                console.log('Video stitching completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Video stitching error:', err);
                reject(err);
            })
            .run();
    });
}

// Add audio to video
async function addAudioToVideo(videoPath, audioPath, outputPath, audioDuration = 60) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions([
                '-c:v', 'copy',           // Copy video without re-encoding
                '-c:a', 'aac',            // Audio codec
                '-map', '0:v:0',          // Map video from first input
                '-map', '1:a:0',          // Map audio from second input
                '-shortest'               // End when shortest stream ends
            ])
            .output(outputPath)
            .on('end', () => {
                console.log('Audio addition completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Audio addition error:', err);
                reject(err);
            })
            .run();
    });
}

// Main processing endpoint
app.post('/process-videos', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting job ${jobId}`);
    
    try {
        const { videos, mv_audio } = req.body;
        
        if (!videos || !Array.isArray(videos) || !mv_audio) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected videos array and mv_audio URL' 
            });
        }

        // Create job-specific temp directory
        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        // Step 1: Download and trim audio to 1 minute
        console.log('Step 1: Processing audio...');
        const audioPath = path.join(jobDir, 'audio.mp3');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        
        await downloadFile(mv_audio, audioPath);
        await trimAudio(audioPath, trimmedAudioPath, 60);

        // Step 2: Download all videos
        console.log('Step 2: Downloading videos...');
        const videoPaths = [];
        
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const videoPath = path.join(jobDir, `video_${video.scene_number}.mp4`);
            await downloadFile(video.final_video_url, videoPath);
            videoPaths.push(videoPath);
            console.log(`Downloaded video ${i + 1}/${videos.length}`);
        }

        // Step 3: Stitch videos together
        console.log('Step 3: Stitching videos...');
        const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
        await stitchVideos(videoPaths, stitchedVideoPath);

        // Step 4: Add trimmed audio to stitched video
        console.log('Step 4: Adding audio to final video...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioToVideo(stitchedVideoPath, trimmedAudioPath, finalVideoPath);

        // Step 5: Get final video stats
        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        // Cleanup temp files
        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            processedVideos: videos.length,
            message: `Successfully processed ${videos.length} videos with 1-minute audio track`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

// Download endpoint
app.get('/download/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        // Check if file exists
        await fs.access(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="final_video_${jobId}.mp4"`);
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ error: 'Video not found' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'Video Stitching Service' });
});

// Status endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Video Stitching Service',
        version: '1.0.0',
        endpoints: {
            process: 'POST /process-videos',
            download: 'GET /download/:jobId',
            health: 'GET /health'
        },
        usage: {
            description: 'Send POST request to /process-videos with your video data',
            example: {
                videos: [
                    { scene_number: 1, final_video_url: 'https://...' },
                    { scene_number: 2, final_video_url: 'https://...' }
                ],
                mv_audio: 'https://audio-url.com/audio.mp3'
            }
        }
    });
});

// Initialize and start server
async function startServer() {
    await ensureDirectories();
    
    app.listen(PORT, () => {
        console.log(`Video Stitching Service running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
    });
}

startServer().catch(console.error);