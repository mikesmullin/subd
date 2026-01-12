import readline from 'readline';
import { EventEmitter } from 'events';
import { globals } from './globals.mjs';

export class PasteAwareInput extends EventEmitter {
    constructor(options) {
        super();
        this.rl = readline.createInterface(options);
        
        // Configuration
        this.debounceTime = globals.pasteDetectionThreshold || 100;
        this.lineBuffer = []; // Current batch of lines arriving quickly
        this.accumulatedBuffer = []; // Lines held from previous paste batches
        this.flushTimer = null;

        // Intercept line events
        this.rl.on('line', this.handleLine.bind(this));
        
        // Forward other events
        this.rl.on('close', () => {
            this.flush();
            this.emit('close');
        });
        this.rl.on('SIGINT', () => {
            // Clear buffers on interrupt
            this.lineBuffer = [];
            this.accumulatedBuffer = [];
            if (this.flushTimer) clearTimeout(this.flushTimer);
            this.emit('SIGINT');
        });
        // Let readline handle SIGTSTP (Ctrl+Z) and SIGCONT default behaviors (background/foreground)
        // by not attaching listeners here.
        // Note: readline doesn't emit 'history', it exposes it as a property
    }

    handleLine(line) {
        // Add to buffer
        this.lineBuffer.push(line);

        // Reset timer
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }

        this.flushTimer = setTimeout(() => {
            this.flush();
        }, this.debounceTime);
    }

    flush() {
        if (this.lineBuffer.length === 0) return;

        // Determine if this batch looks like a paste
        // 1. Multiple lines arrived within debounce window
        // 2. OR single line arrived but there is more text pending in readline buffer (tail of paste)
        const isPasteBatch = this.lineBuffer.length > 1 || (this.lineBuffer.length === 1 && this.rl.line.length > 0);

        if (isPasteBatch) {
            // It's a paste (or part of one). Accumulate and wait.
            this.accumulatedBuffer.push(...this.lineBuffer);
            // Do not emit 'line' yet.
            // The user will see the text echoed by readline.
        } else {
            // It's a manual entry (single line, no pending tail)
            // Combine with any accumulated lines and submit.
            const allLines = [...this.accumulatedBuffer, ...this.lineBuffer];
            const combined = allLines.join('\n');
            this.emit('line', combined);
            this.accumulatedBuffer = [];
        }
        
        this.lineBuffer = [];
        this.flushTimer = null;
    }

    // Proxy methods
    prompt(preserveCursor) {
        this.rl.prompt(preserveCursor);
    }

    setPrompt(prompt) {
        this.rl.setPrompt(prompt);
    }

    close() {
        this.rl.close();
    }
    
    pause() {
        this.rl.pause();
    }
    
    resume() {
        this.rl.resume();
    }
    
    write(d, key) {
        this.rl.write(d, key);
    }
    
    get input() { return this.rl.input; }
    get output() { return this.rl.output; }
    get history() { return this.rl.history; }
    set history(h) { this.rl.history = h; }
    get line() { return this.rl.line; }
    get cursor() { return this.rl.cursor; }
}
