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

// Job status tracking
const jobStatus = new Map();
const STATUS = {
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Create output directory
async function ensureDirectories() {
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
    } catch (error) {
        console.log('Directories already exist or error creating:', error.message);
    }
}

// Update job status
function updateJobStatus(jobId, status, progress = 0, extra = {}) {
    const existing = jobStatus.get(jobId) || {};
    jobStatus.set(jobId, {
        ...existing,
        status,
        progress,
        ...extra,
        lastUpdated: new Date().toISOString()
    });
}

// Download file from URL
async function downloadFile(url, filepath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000 // 60 second timeout
    });

    const writer = require('fs').createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Trim audio to specified duration
async function trimAudio(inputPath, outputPath, duration = 60) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .outputOptions([
                '-c:a', 'aac',
                '-b:a', '128k'
            ])
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

// Check if video has audio stream
async function hasAudioStream(videoPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                resolve(false);
            } else {
                const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                resolve(hasAudio);
            }
        });
    });
}

// Validate video file
async function validateVideo(videoPath) {
    try {
        await getVideoDuration(videoPath);
        return true;
    } catch (error) {
        console.error(`Video validation failed for ${videoPath}:`, error.message);
        return false;
    }
}

// Stitch videos together with proper scene ordering
async function stitchVideos(videoPaths, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            // Validate all videos first
            const validationResults = await Promise.all(
                videoPaths.map(async (path, index) => {
                    const isValid = await validateVideo(path);
                    if (!isValid) {
                        throw new Error(`Invalid video file at index ${index}: ${path}`);
                    }
                    return isValid;
                })
            );

            // Check if any video has audio
            const audioChecks = await Promise.all(videoPaths.map(hasAudioStream));
            const hasAnyAudio = audioChecks.some(hasAudio => hasAudio);
            
            const command = ffmpeg();
            
            // Add all video inputs in order
            videoPaths.forEach(videoPath => {
                command.input(videoPath);
            });

            if (hasAnyAudio) {
                // Some videos have audio - use complex filter with audio handling
                const videoInputs = videoPaths.map((_, index) => `[${index}:v]`).join('');
                const audioInputs = videoPaths.map((_, index) => {
                    return audioChecks[index] ? `[${index}:a]` : 'anullsrc=channel_layout=stereo:sample_rate=48000[silent${index}]; [silent${index}]';
                }).join('');
                
                const filterComplex = `${videoInputs}concat=n=${videoPaths.length}:v=1:a=0[outv]; ${audioInputs}concat=n=${videoPaths.length}:v=0:a=1[outa]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]', '-map', '[outa]']);
            } else {
                // No audio in any video - video-only concatenation
                const filterComplex = videoPaths.map((_, index) => `[${index}:v]`).join('') + 
                                     `concat=n=${videoPaths.length}:v=1:a=0[outv]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]']);
            }

            command
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'medium',
                    '-crf', '23',
                    '-pix_fmt', 'yuv420p'
                ])
                .output(outputPath)
                .on('progress', (progress) => {
                    console.log(`Stitching progress: ${progress.percent}%`);
                })
                .on('end', () => {
                    console.log('Video stitching completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Video stitching error:', err);
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

// Add audio to video
async function addAudioToVideo(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions([
                '-c:v', 'copy',           // Copy video without re-encoding
                '-c:a', 'aac',            // Audio codec
                '-b:a', '128k',           // Audio bitrate
                '-map', '0:v:0',          // Map video from first input
                '-map', '1:a:0',          // Map audio from second input
                '-shortest'               // End when shortest stream ends
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                console.log(`Audio mixing progress: ${progress.percent}%`);
            })
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
    
    // Initialize job status
    updateJobStatus(jobId, STATUS.PROCESSING, 0, {
        startTime: new Date().toISOString()
    });
    
    try {
        const { videos, mv_audio, total_videos } = req.body;
        
        // Validation
        if (!videos || !Array.isArray(videos) || !mv_audio) {
            updateJobStatus(jobId, STATUS.FAILED, 0, {
                error: 'Invalid input. Expected videos array and mv_audio URL',
                failedTime: new Date().toISOString()
            });
            return res.status(400).json({ 
                error: 'Invalid input. Expected videos array and mv_audio URL',
                jobId: jobId
            });
        }

        if (videos.length === 0) {
            updateJobStatus(jobId, STATUS.FAILED, 0, {
                error: 'No videos provided',
                failedTime: new Date().toISOString()
            });
            return res.status(400).json({ 
                error: 'No videos provided',
                jobId: jobId
            });
        }

        // Validate scene numbers and URLs
        const invalidVideos = videos.filter(v => 
            !v.scene_number || !v.final_video_url || 
            isNaN(parseInt(v.scene_number, 10))
        );
        
        if (invalidVideos.length > 0) {
            updateJobStatus(jobId, STATUS.FAILED, 0, {
                error: `Invalid video entries: ${invalidVideos.length} videos missing scene_number or final_video_url`,
                failedTime: new Date().toISOString()
            });
            return res.status(400).json({ 
                error: `Invalid video entries: ${invalidVideos.length} videos missing scene_number or final_video_url`,
                jobId: jobId
            });
        }

        // Create job-specific temp directory
        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        updateJobStatus(jobId, STATUS.PROCESSING, 10, {
            message: 'Processing audio...'
        });

        // Step 1: Download and process audio
        console.log('Step 1: Processing audio...');
        const originalAudioPath = path.join(jobDir, 'original_audio');
        const audioPath = path.join(jobDir, 'audio.wav');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        
        try {
            // Download audio file without extension first
            await downloadFile(mv_audio, originalAudioPath);
            
            // Convert to a known format first, then trim
            console.log('Converting audio to standard format...');
            await new Promise((resolve, reject) => {
                ffmpeg(originalAudioPath)
                    .inputOptions(['-f', 'mp3']) // Force input format as mp3
                    .audioCodec('pcm_s16le')
                    .audioChannels(2)
                    .audioFrequency(44100)
                    .output(audioPath)
                    .on('start', (cmd) => console.log('Audio conversion command:', cmd))
                    .on('end', () => {
                        console.log('Audio format conversion completed');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Audio conversion failed:', err);
                        // Try without forcing input format
                        ffmpeg(originalAudioPath)
                            .audioCodec('pcm_s16le')
                            .audioChannels(2)
                            .audioFrequency(44100)
                            .output(audioPath)
                            .on('end', resolve)
                            .on('error', reject)
                            .run();
                    })
                    .run();
            });
            
            // Now trim the converted audio
            console.log('Trimming audio to 60 seconds...');
            await new Promise((resolve, reject) => {
                ffmpeg(audioPath)
                    .setStartTime(0)
                    .setDuration(60)
                    .audioCodec('aac')
                    .audioBitrate('128k')
                    .audioChannels(2)
                    .audioFrequency(44100)
                    .output(trimmedAudioPath)
                    .on('start', (cmd) => console.log('Audio trimming command:', cmd))
                    .on('end', () => {
                        console.log('Audio trimming completed successfully');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Audio trimming failed:', err);
                        reject(new Error(`Audio trimming failed: ${err.message}`));
                    })
                    .run();
            });
            
        } catch (error) {
            // Final fallback: skip audio processing and create silent audio
            console.warn('Audio processing failed completely, creating silent audio track:', error.message);
            
            try {
                await new Promise((resolve, reject) => {
                    ffmpeg()
                        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
                        .inputOptions(['-f', 'lavfi'])
                        .setDuration(60)
                        .audioCodec('aac')
                        .audioBitrate('128k')
                        .output(trimmedAudioPath)
                        .on('end', () => {
                            console.log('Silent audio track created as fallback');
                            resolve();
                        })
                        .on('error', reject)
                        .run();
                });
            } catch (silentError) {
                throw new Error(`Cannot create audio track: ${error.message}. Silent fallback also failed: ${silentError.message}`);
            }
        }

        updateJobStatus(jobId, STATUS.PROCESSING, 20, {
            message: 'Downloading and sorting videos...'
        });

        // Step 2: Sort videos by scene number, then download
        console.log('Step 2: Sorting and downloading videos...');
        
        // Sort videos by scene_number to ensure correct order
        const sortedVideos = videos.sort((a, b) => {
            const sceneA = parseInt(a.scene_number, 10);
            const sceneB = parseInt(b.scene_number, 10);
            return sceneA - sceneB;
        });

        console.log('Video processing order:', sortedVideos.map(v => `Scene ${v.scene_number}`).join(' -> '));

        // Validate sequence (optional but recommended)
        const sceneNumbers = sortedVideos.map(v => parseInt(v.scene_number, 10));
        const expectedSequence = Array.from({length: sceneNumbers.length}, (_, i) => i + 1);
        const missingScenes = expectedSequence.filter(num => !sceneNumbers.includes(num));
        
        if (missingScenes.length > 0) {
            console.warn('Warning: Non-sequential scene numbers detected. Missing:', missingScenes);
        }

        const videoPaths = [];
        const totalSteps = sortedVideos.length;
        
        for (let i = 0; i < sortedVideos.length; i++) {
            const video = sortedVideos[i];
            const videoPath = path.join(jobDir, `video_${String(video.scene_number).padStart(3, '0')}.mp4`);
            
            try {
                await downloadFile(video.final_video_url, videoPath);
                
                // Validate downloaded video
                const isValid = await validateVideo(videoPath);
                if (!isValid) {
                    throw new Error(`Downloaded video for scene ${video.scene_number} is invalid or corrupted`);
                }
                
                videoPaths.push(videoPath);
                console.log(`Downloaded video ${i + 1}/${sortedVideos.length}: Scene ${video.scene_number}`);
                
                // Update progress
                const progress = 20 + Math.floor((i + 1) / totalSteps * 40);
                updateJobStatus(jobId, STATUS.PROCESSING, progress, {
                    message: `Downloaded ${i + 1}/${sortedVideos.length} videos`
                });
                
            } catch (error) {
                console.error(`Failed to download Scene ${video.scene_number}:`, error.message);
                throw new Error(`Failed to download video for scene ${video.scene_number}: ${error.message}`);
            }
        }

        console.log(`Successfully downloaded ${videoPaths.length} videos in order`);

        updateJobStatus(jobId, STATUS.PROCESSING, 60, {
            message: 'Stitching videos together...'
        });

        // Step 3: Stitch videos together
        console.log('Step 3: Stitching videos...');
        const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
        await stitchVideos(videoPaths, stitchedVideoPath);

        updateJobStatus(jobId, STATUS.PROCESSING, 80, {
            message: 'Adding audio to final video...'
        });

        // Step 4: Add trimmed audio to stitched video
        console.log('Step 4: Adding audio to final video...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioToVideo(stitchedVideoPath, trimmedAudioPath, finalVideoPath);

        // Step 5: Get final video stats
        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        const videoStats = {
            duration: finalDuration,
            fileSize: stats.size,
            fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
        };

        updateJobStatus(jobId, STATUS.COMPLETED, 100, {
            completedTime: new Date().toISOString(),
            videoStats: videoStats,
            processedVideos: videos.length,
            message: `Successfully processed ${videos.length} videos with 1-minute audio track`
        });

        // Cleanup temp files
        try {
            await fs.rm(jobDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.warn(`Cleanup warning for job ${jobId}:`, cleanupError.message);
        }

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            videoStats: videoStats,
            processedVideos: videos.length,
            sceneOrder: sortedVideos.map(v => parseInt(v.scene_number, 10)),
            message: `Successfully processed ${videos.length} videos with 1-minute audio track`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        
        updateJobStatus(jobId, STATUS.FAILED, 0, {
            error: error.message,
            failedTime: new Date().toISOString()
        });
        
        // Cleanup on failure
        try {
            const jobDir = path.join(TEMP_DIR, jobId);
            await fs.rm(jobDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.warn(`Cleanup error for failed job ${jobId}:`, cleanupError.message);
        }
        
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

// Status check endpoint
app.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const status = jobStatus.get(jobId);
    
    if (!status) {
        return res.status(404).json({ 
            error: 'Job not found',
            jobId: jobId 
        });
    }
    
    res.json({
        jobId: jobId,
        status: status.status,
        progress: status.progress,
        message: status.message || null,
        startTime: status.startTime,
        completedTime: status.completedTime || null,
        failedTime: status.failedTime || null,
        error: status.error || null,
        videoStats: status.videoStats || null,
        processedVideos: status.processedVideos || null,
        downloadUrl: status.status === STATUS.COMPLETED ? `/download/${jobId}` : null,
        lastUpdated: status.lastUpdated
    });
});

// Download endpoint
app.get('/download/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        // Check if file exists
        await fs.access(filePath);
        
        // Get file stats for response headers
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="final_video_${jobId}.mp4"`);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Accept-Ranges', 'bytes');
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Video Stitching Service',
        timestamp: new Date().toISOString(),
        activeJobs: jobStatus.size
    });
});

// Status endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Video Stitching Service',
        version: '2.0.0',
        features: [
            'Scene number ordering',
            'Video validation',
            'Progress tracking',
            'Error handling',
            'Audio mixing'
        ],
        endpoints: {
            process: 'POST /process-videos',
            status: 'GET /status/:jobId', 
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
                mv_audio: 'https://audio-url.com/audio.mp3',
                total_videos: 2
            }
        }
    });
});

// Cleanup old jobs periodically (optional)
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [jobId, status] of jobStatus.entries()) {
        const jobTime = new Date(status.startTime).getTime();
        if (now - jobTime > maxAge) {
            jobStatus.delete(jobId);
            console.log(`Cleaned up old job status: ${jobId}`);
        }
    }
}, 60 * 60 * 1000); // Run every hour

// Initialize and start server
async function startServer() {
    await ensureDirectories();
    
    app.listen(PORT, () => {
        console.log(`Video Stitching Service v2.0.0 running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`Features: Scene ordering, validation, progress tracking`);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    process.exit(0);
});

startServer().catch(console.error);
