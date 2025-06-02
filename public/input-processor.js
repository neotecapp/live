// public/input-processor.js

// Constants for audio processing
const TARGET_SAMPLE_RATE = 16000;
const PROCESSOR_BUFFER_SIZE = 512; // Reduced from 4096 for lower latency

class InputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.inputSampleRate = options.processorOptions ? options.processorOptions.inputSampleRate : sampleRate; // sampleRate is global in AudioWorkletProcessor
    this.buffer = []; // Buffer to hold incoming Float32 samples
    this.totalSamplesCollected = 0;

    console.log(`InputProcessor initialized. AudioWorkletGlobalScope sampleRate: ${sampleRate}, configured inputSampleRate: ${this.inputSampleRate}`);
    if (this.inputSampleRate === 0) {
        console.warn("InputProcessor: inputSampleRate is 0, this might indicate an issue with AudioContext sampleRate propagation.");
        // Fallback if sampleRate is not properly passed or detected, though 'sampleRate' global should be reliable.
        this.inputSampleRate = 48000; // Common default
    }
  }

  process(inputs, outputs, parameters) {
    // We expect one input, and the first channel of that input.
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true; // Keep processor alive
    }

    const inputChannelData = input[0]; // Float32Array

    if (inputChannelData) {
      // Add new samples to our buffer
      this.buffer.push(...inputChannelData);
      this.totalSamplesCollected += inputChannelData.length;

      // Process and send data if enough samples have been collected
      // This attempts to roughly match the 4096 buffer size of the old ScriptProcessorNode,
      // but it's based on the input sample rate.
      if (this.totalSamplesCollected >= PROCESSOR_BUFFER_SIZE) {
        const combinedBuffer = new Float32Array(this.buffer);
        this.buffer = []; // Clear buffer for next chunk
        this.totalSamplesCollected = 0;

        // Downsample and convert to 16-bit PCM using Linear Interpolation
        const ratio = this.inputSampleRate / TARGET_SAMPLE_RATE;
        const outputLength = Math.floor(combinedBuffer.length / ratio);
        const pcmData = new ArrayBuffer(outputLength * 2); // 2 bytes per 16-bit sample
        const pcmView = new DataView(pcmData);

        for (let i = 0; i < outputLength; i++) {
          const exactInputIndex = i * ratio;
          const indexPrev = Math.floor(exactInputIndex);
          const indexNext = Math.min(indexPrev + 1, combinedBuffer.length - 1); // Ensure indexNext is within bounds
          const fraction = exactInputIndex - indexPrev;

          const samplePrev = combinedBuffer[indexPrev];
          const sampleNext = combinedBuffer[indexNext];

          let interpolatedSample = samplePrev + (sampleNext - samplePrev) * fraction;

          interpolatedSample = Math.max(-1, Math.min(1, interpolatedSample)); // Clamp to [-1, 1]
          pcmView.setInt16(i * 2, interpolatedSample * 0x7FFF, true); // Convert to 16-bit signed int (little-endian)
        }

        // Post the PCM data back to the main thread
        this.port.postMessage(pcmData);
      }
    }
    return true; // Keep processor alive
  }
}

registerProcessor('input-processor', InputProcessor);
