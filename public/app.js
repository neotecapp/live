const startButton = document.getElementById('startButton');
const endButton = document.getElementById('endButton');
const statusDiv = document.getElementById('status');

let audioContext; // For microphone input processing AND playback
let mediaStreamSource;
let inputNode; // For AudioWorkletNode
let localStream;
let webSocket;

const TARGET_SAMPLE_RATE = 16000; // Still used by input-processor.js
const PLAYBACK_SAMPLE_RATE = 24000; // Live API audio output is 24kHz
const PLAYBACK_BUFFER_TARGET_DURATION_MS = 500; // Target 0.5 seconds of audio per playback chunk
const MIN_SAMPLES_TO_START_PLAYBACK = PLAYBACK_SAMPLE_RATE * (PLAYBACK_BUFFER_TARGET_DURATION_MS / 1000);


// Audio playback state
let clientPlaybackBuffer = []; // Stores Float32 samples for playback
let isPlaying = false;
let audioPlaybackNode; // To keep track of the current source node for playback

startButton.addEventListener('click', startSession);
endButton.addEventListener('click', endSession);

async function startSession() {
    statusDiv.textContent = 'Starting session...';
    startButton.disabled = true;
    // endButton will be enabled by server 'AI session opened' message

    try {
        // Initialize microphone input
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Microphone access granted and stream obtained.");
        statusDiv.textContent = 'Microphone access granted.';

        // Use a single AudioContext for both input and output
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created.");

        // --- Input setup ---
        mediaStreamSource = audioContext.createMediaStreamSource(localStream);

        // --- AudioWorklet Input setup ---
        if (!audioContext.audioWorklet) {
            console.error("AudioWorklet is not supported by this browser.");
            statusDiv.textContent = "AudioWorklet not supported. Please use a modern browser.";
            endSessionCleanup();
            return;
        }

        try {
            await audioContext.audioWorklet.addModule('input-processor.js');
            console.log("AudioWorklet module 'input-processor.js' loaded.");
        } catch (e) {
            console.error("Failed to load audio worklet module:", e);
            statusDiv.textContent = "Error loading audio processor. See console.";
            endSessionCleanup();
            return;
        }

        inputNode = new AudioWorkletNode(audioContext, 'input-processor', {
            processorOptions: {
                inputSampleRate: audioContext.sampleRate
                // PROCESSOR_BUFFER_SIZE and TARGET_SAMPLE_RATE are constants within the worklet
            }
        });
        console.log("AudioWorkletNode 'input-processor' created.");

        inputNode.port.onmessage = (event) => {
            // event.data is the ArrayBuffer (PCM data) from the worklet
            if (event.data) {
                if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(event.data); // Send raw ArrayBuffer
                } else {
                    // console.log("WebSocket not open for sending worklet data. State:", webSocket ? webSocket.readyState : "webSocket is null");
                }
            }
        };

        mediaStreamSource.connect(inputNode);

        // To prevent local echo and ensure the graph keeps processing,
        // connect the inputNode to a GainNode with gain 0, then to destination.
        const gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(0, audioContext.currentTime); // Mute local feedback
        inputNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
        console.log("AudioWorkletNode connected via muted GainNode to destination.");

        // --- WebSocket setup ---
        // Determine WebSocket protocol (ws or wss)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        webSocket = new WebSocket(wsUrl);

        webSocket.onopen = () => {
            console.log('WebSocket connection established.');
            statusDiv.textContent = 'Connected to server. Waiting for AI...';
            // Server will send 'AI session opened'
        };

        webSocket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'audio_data') {
                    // Received base64 encoded audio data from server
                    const audioData = base64ToArrayBuffer(message.data);
                    // The audio from Live API is 16-bit PCM, 24kHz, mono.
                    queueAudio(audioData);
                } else if (message.type === 'status') {
                    console.log('Status from server:', message.message);
                    statusDiv.textContent = message.message;
                    if (message.message === 'AI session opened.') {
                        endButton.disabled = false;
                        statusDiv.textContent = 'Session started. Listening...';
                    } else if (message.message === 'AI session closed.') {
                        // Handle server-initiated close if needed
                        if (!startButton.disabled) { // If we didn't initiate close
                            endSessionCleanup();
                        }
                    }
                } else if (message.type === 'error') {
                    console.error('Error from server:', message.message);
                    statusDiv.textContent = `Server Error: ${message.message}`;
                    endSession(); // Or handle more gracefully
                }
            } catch (e) {
                console.error("Failed to parse message from server or unknown message type:", event.data, e);
            }
        };

        webSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            statusDiv.textContent = 'WebSocket error. Please try again.';
            endSessionCleanup(); // Clean up resources
            startButton.disabled = false;
            endButton.disabled = true;
        };

        webSocket.onclose = (event) => {
            console.log('WebSocket connection closed:', event.reason);
            if (!startButton.disabled) { // If not closed by user clicking "End Session"
                statusDiv.textContent = 'Connection closed. Ready to start...';
            }
            endSessionCleanup(); // Ensure cleanup if connection drops
        };

    } catch (err) {
        console.error("Error in startSession:", err);
        statusDiv.textContent = `Error: ${err.message}`;
        endSessionCleanup();
        startButton.disabled = false;
        endButton.disabled = true;
    }
}

function endSession() {
    statusDiv.textContent = 'Ending session...';
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        // Optionally send a control message to server before closing
        // webSocket.send(JSON.stringify({ type: 'control', command: 'end_session' }));
        webSocket.close(1000, "User ended session"); // 1000 is normal closure
    } else {
        // If WebSocket is not open or already closed, just cleanup
        endSessionCleanup();
    }
    // Cleanup will also be called by webSocket.onclose
}

function endSessionCleanup() {
    console.log("Running cleanup...");
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (inputNode) {
        inputNode.port.onmessage = null; // Remove message handler
        inputNode.disconnect();
        inputNode = null;
        console.log("InputNode disconnected and cleaned up.");
    }
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        mediaStreamSource = null;
    }

    // Stop any ongoing playback and clear queue
    if (audioPlaybackNode) {
        audioPlaybackNode.stop();
        audioPlaybackNode.disconnect();
        audioPlaybackNode = null;
    }
    clientPlaybackBuffer = []; // Reset playback buffer
    isPlaying = false;

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => {
            console.log("AudioContext closed.");
            audioContext = null;
        }).catch(e => console.error("Error closing AudioContext:", e));
    }


    startButton.disabled = false;
    endButton.disabled = true;
    if (statusDiv.textContent.startsWith('Ending session') || statusDiv.textContent.startsWith('Session started')) {
       statusDiv.textContent = 'Session ended. Ready to start...';
    }
    console.log('Session ended and cleaned up.');
}


function downsampleAndConvertTo16BitPCM(inputFloat32Array, inputSampleRate, outputSampleRate) {
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(inputFloat32Array.length / ratio);
    const outputBuffer = new ArrayBuffer(outputLength * 2);
    const outputView = new DataView(outputBuffer);
    for (let i = 0; i < outputLength; i++) {
        const inputIndex = Math.floor(i * ratio);
        let sample = inputFloat32Array[inputIndex];
        sample = Math.max(-1, Math.min(1, sample));
        outputView.setInt16(i * 2, sample * 32767, true);
    }
    return outputBuffer;
}

function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    // Important: The data from Live API is 16-bit PCM.
    // We need to ensure this ArrayBuffer is interpreted correctly when creating the AudioBuffer.
    // The `decodeAudioData` expects a full audio file format (like WAV),
    // or raw PCM data if we construct the AudioBuffer manually.
    // For simplicity with raw PCM, we'll construct it manually.
    return bytes.buffer;
}

function queueAudio(arrayBuffer) {
    // The received audio is 16-bit PCM, 24kHz, mono.
    // Convert ArrayBuffer to Int16Array then to Float32Array for Web Audio API
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0; // Convert to [-1.0, 1.0] range
    }

    // Add new samples to the global playback buffer
    // Consider clientPlaybackBuffer.push(...float32Array); for potentially better performance
    for (let i = 0; i < float32Array.length; i++) {
        clientPlaybackBuffer.push(float32Array[i]);
    }

    schedulePlayback(); // Attempt to play if conditions are met
}

function schedulePlayback() {
    if (isPlaying || !audioContext || audioContext.state !== 'running') {
        return; // Already playing or audio context not ready
    }

    if (clientPlaybackBuffer.length >= MIN_SAMPLES_TO_START_PLAYBACK) {
        isPlaying = true;

        // Determine chunk size to play
        // Play up to 2x target duration to avoid too many small chunks if data arrives fast,
        // but not less than MIN_SAMPLES_TO_START_PLAYBACK unless it's all that's left.
        const samplesToPlayCount = Math.min(clientPlaybackBuffer.length, Math.max(MIN_SAMPLES_TO_START_PLAYBACK, PLAYBACK_SAMPLE_RATE * (PLAYBACK_BUFFER_TARGET_DURATION_MS / 1000) * 2));

        // If buffer has less than MIN_SAMPLES_TO_START_PLAYBACK but is not empty, and we decided to play (e.g. end of stream),
        // this logic might need adjustment, but current check `clientPlaybackBuffer.length >= MIN_SAMPLES_TO_START_PLAYBACK` handles this.

        const samplesToPlay = new Float32Array(clientPlaybackBuffer.splice(0, samplesToPlayCount));

        if (samplesToPlay.length === 0) {
            isPlaying = false; // Should not happen if MIN_SAMPLES_TO_START_PLAYBACK > 0
            return;
        }

        const audioBuffer = audioContext.createBuffer(1, samplesToPlay.length, PLAYBACK_SAMPLE_RATE);
        audioBuffer.copyToChannel(samplesToPlay, 0);

        audioPlaybackNode = audioContext.createBufferSource();
        audioPlaybackNode.buffer = audioBuffer;
        audioPlaybackNode.connect(audioContext.destination);

        audioPlaybackNode.onended = () => {
            isPlaying = false;
            // Immediately try to schedule next chunk if more data is available
            schedulePlayback();
        };

        audioPlaybackNode.start();
    }
}

// Initial state
endButton.disabled = true;
