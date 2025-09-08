// Normalize + stitch videos (video-only concat, safe mode)
async function stitchVideos(videoPaths, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const tempDir = path.dirname(outputPath);
            const normalizedPaths = [];

            // Step 1: Normalize all videos to same format
            for (let i = 0; i < videoPaths.length; i++) {
                const inputPath = videoPaths[i];
                const normalizedPath = path.join(tempDir, `normalized_${i}.mp4`);

                await new Promise((res, rej) => {
                    ffmpeg(inputPath)
                        .outputOptions([
                            '-vf', 'scale=1280:720,fps=30', // force same size + fps
                            '-c:v', 'libx264',              // re-encode to H.264
                            '-preset', 'fast',
                            '-crf', '23',
                            '-an'                           // remove audio
                        ])
                        .save(normalizedPath)
                        .on('end', res)
                        .on('error', rej);
                });

                normalizedPaths.push(normalizedPath);
            }

            // Step 2: Build concat filter
            const command = ffmpeg();
            normalizedPaths.forEach(p => command.input(p));

            const filterComplex =
                normalizedPaths.map((_, idx) => `[${idx}:v:0]`).join('') +
                `concat=n=${normalizedPaths.length}:v=1:a=0[outv]`;

            command
                .complexFilter(filterComplex)
                .outputOptions(['-map', '[outv]'])
                .save(outputPath)
                .on('end', () => {
                    console.log('✅ Video stitching completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ Video stitching error:', err);
                    reject(err);
                });
        } catch (error) {
            reject(error);
        }
    });
}
