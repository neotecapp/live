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
const liveConfig = {
    responseModalities: [Modality.AUDIO],
    // Consider adding other configs like systemInstruction, affectiveDialog, etc. later if needed
    // systemInstruction: "You are a helpful voice assistant.",
    // enableAffectiveDialog: true, // Requires v1alpha API version
};

// Serve static files (index.html, app.js)
app.use(express.static('public')); // Assuming index.html and app.js will be moved to a 'public' folder

wss.on('connection', async (ws) => {
    console.log('Client connected via WebSocket');
    let liveSession;

    try {
        liveSession = await ai.live.connect({
            model: modelName,
            config: liveConfig,
            callbacks: {
                onopen: () => {
                    console.log('Live API session opened.');
                    ws.send(JSON.stringify({ type: 'status', message: 'AI session opened.' }));
                },
                onmessage: (message) => {
                    // This callback receives messages from the Live API
                    // console.debug('Live API message:', JSON.stringify(message, null, 2));
                    if (message.data) { // Audio data from AI
                        // The 'data' field contains base64 encoded audio
                        ws.send(JSON.stringify({ type: 'audio_data', data: message.data }));
                    } else if (message.serverContent) {
                        if (message.serverContent.outputTranscription) {
                            console.log('AI Output Transcription:', message.serverContent.outputTranscription.text);
                            // We are not displaying transcription in this app, but logging it.
                        }
                        if (message.serverContent.turnComplete) {
                            console.log('AI turn complete.');
                        }
                        if (message.serverContent.interrupted) {
                            console.log('AI generation was interrupted.');
                        }
                    } else if (message.error) {
                        console.error('Live API Error:', message.error.message);
                        ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${message.error.message}` }));
                    }
                    // Handle other message types like toolCall, usageMetadata, etc. if needed
                },
                onerror: (e) => {
                    console.error('Live API Error:', e.message);
                    ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${e.message}` }));
                    if (liveSession) {
                        liveSession.close();
                    }
                },
                onclose: (e) => {
                    console.log('Live API session closed.', e ? e.reason : '');
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
        // This receives messages from the client (our web app)
        // Assuming client sends raw binary audio data (ArrayBuffer)
        // The liveSession object from @google/genai v1.3.0 uses a standard WebSocket connection.
        // .isOpen() is not a valid method; .conn.readyState is used instead.
        if (liveSession && liveSession.conn.readyState === WebSocket.OPEN) {
            if (message instanceof Buffer) { // Check if message is Buffer (binary data)
                // The client-side already converts to 16-bit PCM, 16kHz, mono.
                // The Live API expects base64 encoded audio data.
                const base64Audio = message.toString('base64');
                liveSession.sendRealtimeInput({
                    audio: {
                        data: base64Audio,
                        mimeType: "audio/pcm;rate=16000"
                    }
                });
            } else {
                try {
                    const parsedMessage = JSON.parse(message);
                    if (parsedMessage.type === 'control' && parsedMessage.command === 'end_session_ack') {
                         console.log("Client acknowledged session end. Closing Live API session.");
                         if (liveSession) liveSession.close();
                    }
                    // Handle other JSON messages if any
                } catch (e) {
                    console.log("Received non-binary message from client:", message.toString());
                }
            }
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
