const startButton = document.getElementById('startButton');
const endButton = document.getElementById('endButton');
const statusDiv = document.getElementById('status');

let audioContext; // For microphone input processing AND playback
let mediaStreamSource;
let scriptProcessor;
let localStream;
let webSocket;

const TARGET_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000; // Live API audio output is 24kHz

// Audio playback queue and state
let audioQueue = [];
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
        statusDiv.textContent = 'Microphone access granted.';

        // Use a single AudioContext for both input and output
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // --- Input setup ---
        mediaStreamSource = audioContext.createMediaStreamSource(localStream);
        const bufferSize = 4096; // Process in chunks
        scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1); // 1 input channel, 1 output channel

        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
            const inputBuffer = audioProcessingEvent.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            const pcmData = downsampleAndConvertTo16BitPCM(inputData, audioContext.sampleRate, TARGET_SAMPLE_RATE);

            if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(pcmData); // Send raw ArrayBuffer
            }
        };
        mediaStreamSource.connect(scriptProcessor);
        // It's important to connect the scriptProcessor to the destination to keep it processing.
        // If you don't want to hear your own microphone, you can connect it to a GainNode with gain 0.
        // For simplicity now, connecting to destination. This might cause echo if speakers are loud.
        const gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(0, audioContext.currentTime); // Mute local playback
        scriptProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);


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
        console.error('Error starting session:', err);
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
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor.onaudioprocess = null;
        scriptProcessor = null;
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
    audioQueue = [];
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

    if (audioContext && audioContext.state === 'running') {
        const audioBuffer = audioContext.createBuffer(1, float32Array.length, PLAYBACK_SAMPLE_RATE); // 1 channel, length, sampleRate
        audioBuffer.copyToChannel(float32Array, 0);
        audioQueue.push(audioBuffer);
        if (!isPlaying) {
            playNextInQueue();
        }
    } else {
        console.warn("AudioContext not available or not running. Cannot play audio.");
    }
}

function playNextInQueue() {
    if (audioQueue.length === 0 || !audioContext || audioContext.state !== 'running') {
        isPlaying = false;
        return;
    }
    isPlaying = true;
    const audioBufferToPlay = audioQueue.shift();
    audioPlaybackNode = audioContext.createBufferSource();
    audioPlaybackNode.buffer = audioBufferToPlay;
    audioPlaybackNode.connect(audioContext.destination);
    audioPlaybackNode.onended = playNextInQueue; // Play next when current finishes
    audioPlaybackNode.start();
}

// Initial state
endButton.disabled = true;
