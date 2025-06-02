# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time voice conversation application that connects users to Google's Gemini AI through a web interface. The application features:
- WebSocket-based real-time communication between client and server
- Audio streaming with Web Audio API for recording and playback
- Integration with Google Gemini's Live API for voice conversations
- Session management with 120-second inactivity timeout
- Dark/light theme toggle

## Architecture

### Client-Server Communication Flow
1. **Client (Browser)** → WebSocket → **Server (Node.js)** → **Google Gemini Live API**
2. Audio is captured at 16kHz on the client and sent as binary data via WebSocket
3. Server forwards audio to Gemini and streams responses back to client
4. Client plays back audio at 24kHz using Web Audio API with immediate, gapless playback

### Key Components
- **server.js**: Express/WebSocket server that manages Google Gemini Live API connections
- **public/app.js**: Client-side application handling UI, audio capture/playback, and WebSocket communication
- **public/input-processor.js**: AudioWorklet for processing microphone input (downsampling to 16kHz)
- **system-instructions.txt**: Instructions for the AI assistant (Rev, a Revolt Motors voice assistant)
- **live-api-docs.txt**: Reference documentation for the Gemini Live API

## Common Development Commands

```bash
# Install dependencies
npm install

# Start the development server (runs on port 3000 by default)
npm start

# Environment setup (required)
export GOOGLE_API_KEY="your-google-api-key"

# Alternative: Set PORT if needed
export PORT=3000
```

## Important Implementation Details

### Audio Processing
- **Input**: Browser microphone → AudioWorklet → Downsample to 16kHz → PCM 16-bit → Binary WebSocket
- **Output**: Binary WebSocket → PCM 16-bit 24kHz → Immediate AudioContext playback
- Ultra-low latency with immediate playback - no buffering delays

### Session Management
- Sessions have a 120-second inactivity timeout
- Timer starts when AI session opens and resets on each turn completion
- WebSocket disconnection triggers cleanup of AI session

### Error Handling
- WebSocket errors and disconnections are handled gracefully
- AI session errors are reported to the client
- Audio context and streams are properly cleaned up on session end
- Interruption handling stops all active audio sources immediately

### Performance Optimizations
- Binary WebSocket messages reduce data transfer by ~33%
- Input buffer reduced to 512 samples for minimal latency
- Immediate audio playback with precise scheduling
- Gapless audio playback using Web Audio API timing

## Testing Considerations

Currently, there are no automated tests. When implementing tests, consider:
- WebSocket connection/disconnection scenarios
- Audio processing pipeline validation
- Session timeout behavior
- Error handling flows

## Development Tips

- Check browser console for detailed logs during development
- Ensure GOOGLE_API_KEY is set before starting the server
- The application requires HTTPS in production for microphone access
- Audio feedback is muted locally to prevent echo