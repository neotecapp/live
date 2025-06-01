const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
// const { WaveFile } = require('wavefile'); // For potential server-side audio processing/debugging

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY"; // User should set this environment variable

if (GOOGLE_API_KEY === "YOUR_GOOGLE_API_KEY") {
    console.warn("Warning: GOOGLE_API_KEY is not set. Please set it as an environment variable or in server.js");
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
const modelName = 'gemini-2.5-flash-preview-native-audio-dialog'; // As per requirements

// Read system instruction from file
let systemInstructionContent = "";
try {
    systemInstructionContent = fs.readFileSync('system-instructions.txt', 'utf8');
    console.log("Successfully read system instructions from file.");
} catch (err) {
    console.error("Error reading system-instructions.txt:", err.message);
    console.log("Proceeding without custom system instructions.");
    // systemInstructionContent will remain ""
}

const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
        voiceConfig: {
            prebuiltVoiceConfig: {
                voiceName: "Enceladus"
            }
        }
    },
    // Consider adding other configs like affectiveDialog, etc. later if needed
    // enableAffectiveDialog: true, // Requires v1alpha API version
};

if (systemInstructionContent) {
    liveConfig.systemInstruction = systemInstructionContent.trim();
}

// Serve static files (index.html, app.js)
app.use(express.static('public')); // Assuming index.html and app.js will be moved to a 'public' folder

wss.on('connection', async (ws) => {
    console.log('Client connected via WebSocket');
    let liveSession;
    let isLiveSessionOpen = false;

    try {
        liveSession = await ai.live.connect({
            model: modelName,
            config: liveConfig,
            callbacks: {
                onopen: () => {
                    console.log('Live API session opened.');
                    isLiveSessionOpen = true; // Set the flag
                    ws.send(JSON.stringify({ type: 'status', message: 'AI session opened.' }));
                },
                onmessage: (message) => {
                    // This callback receives messages from the Live API
                    // console.debug('Live API message:', JSON.stringify(message, null, 2));
                    if (message.data) { // Audio data from AI
                        // The 'data' field contains base64 encoded audio
                        // console.log('[AI -> Client] Sending audio data to client. Approximate size (base64):', message.data.length);
                        ws.send(JSON.stringify({ type: 'audio_data', data: message.data }));
                    } else if (message.serverContent) {
                        // console.log('[AI -> Server] Received serverContent from AI:', JSON.stringify(message.serverContent, null, 2));
                        if (message.serverContent.outputTranscription) {
                            // console.log('AI Output Transcription:', message.serverContent.outputTranscription.text);
                            // We are not displaying transcription in this app, but logging it.
                        }
                        if (message.serverContent.turnComplete) {
                            console.log('AI turn complete.');
                        }
                        if (message.serverContent.interrupted) {
                            console.log('AI generation was interrupted.');
                            ws.send(JSON.stringify({ type: 'interruption' }));
                        }
                    } else if (message.error) {
                        console.error('Live API Error:', message.error.message);
                        ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${message.error.message}` }));
                    }
                    // Handle other message types like toolCall, usageMetadata, etc. if needed
                },
                onerror: (e) => {
                    console.error('[Live API Error] Full error object:', JSON.stringify(e, null, 2));
                    isLiveSessionOpen = false; // Reset the flag
                    ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${e.message}` }));
                    if (liveSession) {
                        liveSession.close(); // Ensure close is called if it exists
                    }
                },
                onclose: (e) => {
                    console.log('Live API session closed.', e ? e.reason : '');
                    isLiveSessionOpen = false; // Reset the flag
                    ws.send(JSON.stringify({ type: 'status', message: 'AI session closed.' }));
                },
            },
        });

        console.log("Live API session connection initiated.");

    } catch (error) {
        console.error('Failed to connect to Live API:', error);
        ws.send(JSON.stringify({ type: 'error', message: `Failed to connect to AI: ${error.message}` }));
        ws.close();
        return;
    }

    ws.on('message', (message) => {
        // console.log('[Server ws.onmessage] Message received. Type:', typeof message, 'Is Buffer:', message instanceof Buffer);

        // Primary check for session readiness
        if (liveSession && isLiveSessionOpen) {
            // console.log('[Server ws.onmessage] Live session IS considered open.');

            if (message instanceof Buffer) {
                // console.log('[Server ws.onmessage] Message is a Buffer. Processing audio.');
                const base64Audio = message.toString('base64');
                // console.log('[Client -> AI] Processing client audio. Raw message size:', message.length, 'Base64 size:', base64Audio.length);
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: base64Audio,
                            mimeType: "audio/pcm;rate=16000"
                        }
                    });
                    // console.log('[Server ws.onmessage] Audio sent to AI via sendRealtimeInput.');
                } catch (error) {
                    console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput:', error);
                }
            } else {
                console.log('[Server ws.onmessage] Message is NOT a Buffer. Attempting to parse as JSON. Content:', message.toString());
                try {
                    const parsedMessage = JSON.parse(message);
                    console.log('[Server ws.onmessage] Parsed JSON message:', parsedMessage);
                    if (parsedMessage.type === 'control' && parsedMessage.command === 'end_session_ack') {
                        console.log("Client acknowledged session end. Closing Live API session.");
                        if (liveSession) liveSession.close();
                    }
                    // Handle other JSON messages if any
                } catch (e) {
                    console.error("[Server ws.onmessage] Failed to parse message as JSON or unknown text message type. Error:", e, "Original message:", message.toString());
                }
            }
        } else {
            console.log('[Server ws.onmessage] Live session not considered open. isLiveSessionOpen:', isLiveSessionOpen, 'liveSession exists:', !!liveSession);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (liveSession) {
            console.log('Closing Live API session due to client disconnect.');
            liveSession.close();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        if (liveSession) {
            liveSession.close();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the app at http://localhost:${PORT}`);
});
