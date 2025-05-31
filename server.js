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

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY, httpOptions: { "apiVersion": "v1alpha" } });
const modelName = 'gemini-2.5-flash-preview-native-audio-dialog'; // As per requirements
const liveConfig = {
    responseModalities: [Modality.AUDIO]
    // realtimeInputConfig: {
    //     automaticActivityDetection: {
    //         disabled: false,
    //         startOfSpeechSensitivity: require('@google/genai').StartSensitivity.START_SENSITIVITY_HIGH,
    //         endOfSpeechSensitivity: require('@google/genai').EndSensitivity.END_SENSITIVITY_HIGH,
    //         prefixPaddingMs: 20, // Explicitly set
    //         silenceDurationMs: 50, // Very short
    //     }
    // }
    // Consider adding other configs like systemInstruction, affectiveDialog, etc. later if needed
    // systemInstruction: "You are a helpful voice assistant.",
    // enableAffectiveDialog: true, // Requires v1alpha API version
};

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
                    if (!message.data) { // Only log if it's not an audio data message
                        console.log('[Live API CTRL Message Received] Type:', message.constructor.name, 'Content:', JSON.stringify(message, null, 2));
                    }

                    if (message.data) {
                        // Verbose logging for audio data can be silenced for this test:
                        // console.log('[AI -> Client] Sending audio data to client. Approximate size (base64):', message.data.length);
                        ws.send(JSON.stringify({ type: 'audio_data', data: message.data }));
                    } else if (message.serverContent) {
                        // This log will be caught by the !message.data above, but specific parsing is good.
                        // console.log('[AI -> Server] Received serverContent from AI:', JSON.stringify(message.serverContent, null, 2)); // This is now part of the generic CTRL message log
                        if (message.serverContent.outputTranscription) {
                            console.log('AI Output Transcription:', message.serverContent.outputTranscription.text);
                        }
                        if (message.serverContent.turnComplete) {
                            console.log('>>> AI turn complete. <<<');
                        }
                        if (message.serverContent.interrupted) {
                            console.log('>>> AI generation was interrupted. <<<');
                        }
                        if (message.serverContent.generationComplete) { // Added this specific log
                            console.log('>>> AI generation complete. <<<');
                        }
                    } else if (message.error) {
                        // This log will also be caught by !message.data if it's not an error object directly on message itself.
                        console.error('Live API Error:', message.error.message); // Assuming error is structured like this.
                        ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${message.error.message}` }));
                    }
                    // Other non-audio, non-serverContent, non-error messages will be caught by the first conditional log.
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
        console.log('[Server ws.onmessage] Message received. Type:', typeof message, 'Is Buffer:', message instanceof Buffer);

        // Primary check for session readiness
        if (liveSession && isLiveSessionOpen) {
            console.log('[Server ws.onmessage] Live session IS considered open.');

            if (message instanceof Buffer) {
                console.log('[Server ws.onmessage] Message is a Buffer. Processing audio.');
                const base64Audio = message.toString('base64');
                console.log('[Client -> AI] Processing client audio. Raw message size:', message.length, 'Base64 size:', base64Audio.length);
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: base64Audio,
                            mimeType: "audio/pcm;rate=16000"
                        }
                    });
                    console.log('[Server ws.onmessage] Audio sent to AI via sendRealtimeInput.');
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
