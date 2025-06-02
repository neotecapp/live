// Get DOM elements
const themeToggle = document.getElementById('theme-toggle');
const sessionToggleButton = document.getElementById('sessionToggleButton');
const body = document.body;

// Session state variables
let isSessionActive = false;
let isLoadingSession = false;
let audioStreamEnded = false;
let pendingPlaybackTimeout = null;

// Audio context and WebSocket variables
let audioContext; // For microphone input processing AND playback
let mediaStreamSource;
let inputNode; // For AudioWorkletNode
let localStream;
let webSocket;

const TARGET_SAMPLE_RATE = 16000; // Still used by input-processor.js
const PLAYBACK_SAMPLE_RATE = 24000; // Live API audio output is 24kHz

// Audio scheduling variables
let nextStartTime = 0;
let activeSources = new Set();

// --- Theme Toggle Functionality ---
function applyTheme(theme) {
    if (theme === 'dark') {
        body.classList.add('dark-mode');
        themeToggle.checked = true;
    } else {
        body.classList.remove('dark-mode');
        themeToggle.checked = false;
    }
}

// Initialize theme
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme);

themeToggle.addEventListener('change', function() {
    if (this.checked) {
        applyTheme('dark');
        localStorage.setItem('theme', 'dark');
    } else {
        applyTheme('light');
        localStorage.setItem('theme', 'light');
    }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    const newColorScheme = e.matches ? 'dark' : 'light';
    applyTheme(newColorScheme);
    localStorage.setItem('theme', newColorScheme);
});

// --- Session Toggle Button Functionality ---
sessionToggleButton.addEventListener('click', function() {
    if (isLoadingSession) {
        return;
    }

    if (isSessionActive) {
        // Ending session
        endSession();
    } else {
        // Starting session
        startSession();
    }
});

async function startSession() {
    isLoadingSession = true;
    sessionToggleButton.disabled = true;
    sessionToggleButton.classList.add('loading-state');
    sessionToggleButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    sessionToggleButton.setAttribute('aria-label', 'Loading session...');

    try {
        // Initialize microphone input
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Microphone access granted and stream obtained.");

        // Use a single AudioContext for both input and output
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created.");

        // --- Input setup ---
        mediaStreamSource = audioContext.createMediaStreamSource(localStream);

        // --- AudioWorklet Input setup ---
        if (!audioContext.audioWorklet) {
            console.error("AudioWorklet is not supported by this browser.");
            endSessionCleanup();
            return;
        }

        try {
            await audioContext.audioWorklet.addModule('input-processor.js');
            console.log("AudioWorklet module 'input-processor.js' loaded.");
        } catch (e) {
            console.error("Failed to load audio worklet module:", e);
            endSessionCleanup();
            return;
        }

        inputNode = new AudioWorkletNode(audioContext, 'input-processor', {
            processorOptions: {
                inputSampleRate: audioContext.sampleRate
            }
        });
        console.log("AudioWorkletNode 'input-processor' created.");

        inputNode.port.onmessage = (event) => {
            if (event.data) {
                if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(event.data);
                }
            }
        };

        mediaStreamSource.connect(inputNode);

        // To prevent local echo and ensure the graph keeps processing
        const gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(0, audioContext.currentTime); // Mute local feedback
        inputNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
        console.log("AudioWorkletNode connected via muted GainNode to destination.");

        // --- WebSocket setup ---
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        webSocket = new WebSocket(wsUrl);

        webSocket.onopen = () => {
            console.log('WebSocket connection established.');
        };

        webSocket.binaryType = 'arraybuffer';
        
        webSocket.onmessage = (event) => {
            try {
                if (event.data instanceof ArrayBuffer) {
                    // Binary message
                    const view = new DataView(event.data);
                    const messageType = view.getUint8(0);
                    
                    if (messageType === 0x01) { // Audio data
                        const audioData = event.data.slice(1);
                        queueAudio(audioData);
                    } else if (messageType === 0x02) { // Turn complete
                        console.log('AI turn complete - flushing remaining audio');
                        audioStreamEnded = true;
                        flushRemainingAudio();
                    } else if (messageType === 0x03) { // Interruption
                        console.log('Interruption message received from server.');
                        
                        // Stop all active audio sources immediately
                        for (const source of activeSources) {
                            try {
                                source.stop();
                            } catch (e) {
                                // Source may have already ended
                            }
                        }
                        activeSources.clear();
                        nextStartTime = 0;
                        audioStreamEnded = false;
                        if (pendingPlaybackTimeout) {
                            clearTimeout(pendingPlaybackTimeout);
                            pendingPlaybackTimeout = null;
                        }
                    }
                } else {
                    // JSON message (for status and error messages)
                    const message = JSON.parse(event.data);
                if (message.type === 'audio_data') {
                    // This case is now handled in binary messages above
                    console.warn('Received audio_data as JSON, expected binary');
                } else if (message.type === 'status') {
                    console.log('Status from server:', message.message);
                    if (message.message === 'AI session opened.') {
                        // Session successfully started
                        playSound('sounds/stream-start.ogg');
                        isSessionActive = true;
                        isLoadingSession = false;
                        sessionToggleButton.disabled = false;
                        sessionToggleButton.classList.remove('loading-state');
                        sessionToggleButton.classList.add('active-session');
                        sessionToggleButton.innerHTML = '<i class="fas fa-stop"></i>';
                        sessionToggleButton.setAttribute('aria-label', 'End session');
                        console.log('Session started successfully');
                    } else if (message.message === 'AI session closed.') {
                        if (isSessionActive) {
                            endSessionCleanup();
                        }
                    }
                } else if (message.type === 'error') {
                    console.error('Error from server:', message.message);
                    endSession();
                } else if (message.type === 'interruption') {
                    // This case is now handled in binary messages above
                    console.warn('Received interruption as JSON, expected binary');
                } else if (message.type === 'turn_complete') {
                    // This case is now handled in binary messages above
                    console.warn('Received turn_complete as JSON, expected binary');
                } else if (message.type === 'session_timeout') {
                    console.log('Session timeout message received from server:', message.message);
                    // Optionally, display a more user-friendly message on the UI, e.g., by updating a status div
                    alert(message.message || 'Session ended due to inactivity.'); // Simple alert for now
                    endSessionCleanup(); // Call existing cleanup function
                }
                }
            } catch (e) {
                console.error("Failed to parse message from server or unknown message type:", event.data, e);
            }
        };

        webSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            endSessionCleanup();
        };

        webSocket.onclose = (event) => {
            console.log('WebSocket connection closed:', event.reason);
            endSessionCleanup();
        };

    } catch (err) {
        console.error("Error in startSession:", err);
        endSessionCleanup();
    }
}

function flushRemainingAudio() {
    // No longer needed with immediate playback
    audioStreamEnded = false;
}

// playRemainingAudio function removed - no longer needed with immediate playback

function endSession() {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        webSocket.close(1000, "User ended session");
    } else {
        endSessionCleanup();
    }
}

function endSessionCleanup() {
    playSound('sounds/stream-end.ogg');
    console.log("Running cleanup...");

    // Clear any pending playback timeout
    if (pendingPlaybackTimeout) {
        clearTimeout(pendingPlaybackTimeout);
        pendingPlaybackTimeout = null;
    }
    
    audioStreamEnded = false;

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (inputNode) {
        inputNode.port.onmessage = null;
        inputNode.disconnect();
        inputNode = null;
        console.log("InputNode disconnected and cleaned up.");
    }
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        mediaStreamSource = null;
    }

    // Stop all active audio sources
    for (const source of activeSources) {
        try {
            source.stop();
        } catch (e) {
            // Source may have already ended
        }
    }
    activeSources.clear();
    nextStartTime = 0;

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => {
            console.log("AudioContext closed.");
            audioContext = null;
        }).catch(e => console.error("Error closing AudioContext:", e));
    }

    // Reset button state
    isSessionActive = false;
    isLoadingSession = false;
    sessionToggleButton.disabled = false;
    sessionToggleButton.classList.remove('loading-state');
    sessionToggleButton.classList.remove('active-session');
    sessionToggleButton.innerHTML = '<i class="fas fa-microphone"></i>';
    sessionToggleButton.setAttribute('aria-label', 'Start session');
    console.log('Session ended and cleaned up.');
}

// base64ToArrayBuffer removed - now using binary WebSocket messages

function playSound(soundFile) {
  try {
    const audio = new Audio();
    audio.src = soundFile;
    audio.play();

    audio.onerror = function() {
      console.error("Error playing sound:", soundFile, audio.error);
    };
  } catch (e) {
    console.error("Error creating or playing audio:", soundFile, e);
  }
}

async function queueAudio(arrayBuffer) {
    if (!audioContext || audioContext.state !== 'running') {
        return;
    }
    
    // The received audio is 16-bit PCM, 24kHz, mono.
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0; // Convert to [-1.0, 1.0] range
    }
    
    // Initialize nextStartTime if needed
    nextStartTime = Math.max(nextStartTime, audioContext.currentTime);
    
    // Create audio buffer
    const audioBuffer = audioContext.createBuffer(1, float32Array.length, PLAYBACK_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32Array, 0);
    
    // Create and schedule source
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    
    source.addEventListener('ended', () => {
        activeSources.delete(source);
    });
    
    // Schedule with precise timing
    source.start(nextStartTime);
    nextStartTime += audioBuffer.duration;
    activeSources.add(source);
}

// schedulePlayback function removed - audio is now played immediately in queueAudio