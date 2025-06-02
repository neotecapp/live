# Real-Time Voice Assistant with Google Gemini Live API

A high-performance, real-time voice conversation application that connects users to Google's Gemini AI through a web interface. Features ultra-low latency audio streaming and a responsive conversational experience.

## Features

- 🎙️ **Real-time voice conversations** with Google Gemini AI
- ⚡ **Ultra-low latency** audio streaming with immediate playback
- 🔊 **High-quality audio** processing (16kHz input, 24kHz output)
- 🌓 **Dark/Light theme** toggle with system preference detection
- 🔒 **Secure API key handling** through server-side proxy
- ⏱️ **Session management** with 120-second inactivity timeout
- 🔄 **Interruption handling** for natural conversation flow

## Architecture

### System Overview
```
Browser → WebSocket → Node.js Server → Google Gemini Live API
```

- **Client**: Web-based interface with Web Audio API integration
- **Server**: Node.js proxy server for secure API communication
- **Protocol**: Binary WebSocket messages for minimal latency
- **Audio**: AudioWorklet for efficient real-time processing

### Key Technologies
- **Frontend**: Vanilla JavaScript, Web Audio API, AudioWorklet
- **Backend**: Node.js, Express, WebSocket (ws)
- **AI**: Google Gemini Live API with native audio support
- **Audio Format**: PCM 16-bit, mono

## Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)
- Google Cloud API key with Gemini API access
- Modern web browser with AudioWorklet support

## Installation

1. Clone the repository:
```bash
git clone https://github.com/dhruvrattan/live.git
cd live
```

2. Install dependencies:
```bash
npm install
```

3. Set up your Google API key:
```bash
export GOOGLE_API_KEY="your-google-api-key"
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

3. Click the microphone button to start a voice conversation

## Configuration

### Environment Variables
- `GOOGLE_API_KEY`: Your Google Cloud API key (required)
- `PORT`: Server port (default: 3000)

### Customizing the AI Assistant

Edit `system-instructions.txt` to customize the AI assistant's personality and behavior. The default configuration creates "Rev", a Revolt Motors voice assistant.

## Performance Optimizations

This implementation achieves ultra-low latency through:

- **Immediate audio playback**: No buffering delays
- **Binary WebSocket messages**: 33% less data transfer than base64
- **Optimized input processing**: 512-sample chunks (reduced from 4096)
- **Precise audio scheduling**: Gapless playback using Web Audio API timing
- **Efficient interruption handling**: Instant audio source management

## Project Structure

```
live/
├── server.js              # Node.js WebSocket server
├── public/
│   ├── index.html        # Main web interface
│   ├── app.js           # Client-side application logic
│   ├── input-processor.js # AudioWorklet for input processing
│   ├── style.css        # UI styles
│   └── sounds/          # Audio feedback files
├── system-instructions.txt # AI assistant configuration
├── package.json          # Node.js dependencies
└── README.md            # This file
```

## Development

### Key Components

1. **Audio Input Pipeline**:
   - Microphone → AudioWorklet → Downsample to 16kHz → Binary WebSocket

2. **Audio Output Pipeline**:
   - Binary WebSocket → PCM decode → Immediate playback at 24kHz

3. **Session Management**:
   - WebSocket connection lifecycle
   - 120-second inactivity timeout
   - Graceful cleanup on disconnect

### Testing

Currently, there are no automated tests. When testing manually:

1. Verify microphone permissions are granted
2. Check browser console for detailed logs
3. Monitor network tab for WebSocket messages
4. Test interruption by speaking while AI is responding

## Security Considerations

- API keys are never exposed to the client
- Server acts as a secure proxy to the Gemini API
- WebSocket connections are properly authenticated
- Audio streams are cleaned up on session end

## Browser Compatibility

Requires a modern browser with support for:
- Web Audio API
- AudioWorklet
- WebSocket
- ES6+ JavaScript

Tested on:
- Chrome/Edge (recommended)
- Firefox
- Safari

## Troubleshooting

### Common Issues

1. **"GOOGLE_API_KEY is not set"**
   - Set the environment variable before starting the server

2. **Microphone not working**
   - Check browser permissions
   - Ensure HTTPS in production (required for mic access)

3. **Audio playback issues**
   - Check browser console for errors
   - Verify audio context is in 'running' state

4. **High latency**
   - Check network connection
   - Ensure server is geographically close to users

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Google Gemini team for the Live API
- Web Audio API community for audio processing insights
- Contributors and testers

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review the browser console for detailed error messages