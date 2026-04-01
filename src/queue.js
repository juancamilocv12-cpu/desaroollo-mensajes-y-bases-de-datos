function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class DispatchQueue {
    constructor(options = {}) {
        this.timingMs = Number(options.timingMs || 1200);
        this.batchSize = Number(options.batchSize || 25);
        this.batchPauseMs = Number(options.batchPauseMs || 20000);
        this.maxRetries = Number(options.maxRetries || 2);
        this.retryDelayMs = Number(options.retryDelayMs || 2500);
        this.jitterMs = Number(options.jitterMs || 300);
    }

    async run({ recipients, worker, onProgress }) {
        let processed = 0;

        for (let i = 0; i < recipients.length; i += 1) {
            const recipient = recipients[i];
            let attempt = 0;
            let success = false;
            let lastError = null;

            while (attempt <= this.maxRetries && !success) {
                try {
                    attempt += 1;
                    const response = await worker(recipient, attempt);
                    success = true;
                    processed += 1;
                    if (onProgress) {
                        onProgress({
                            index: i,
                            processed,
                            total: recipients.length,
                            recipient,
                            attempt,
                            status: "success",
                            response,
                        });
                    }
                } catch (error) {
                    lastError = error;
                    if (attempt <= this.maxRetries) {
                        await sleep(this.retryDelayMs);
                    }
                }
            }

            if (!success && onProgress) {
                processed += 1;
                onProgress({
                    index: i,
                    processed,
                    total: recipients.length,
                    recipient,
                    attempt,
                    status: "failed",
                    error: lastError,
                });
            }

            const isLast = i === recipients.length - 1;
            if (isLast) {
                continue;
            }

            const randomJitter = Math.floor(Math.random() * Math.max(0, this.jitterMs));
            await sleep(this.timingMs + randomJitter);

            if (this.batchSize > 0 && (i + 1) % this.batchSize === 0) {
                await sleep(this.batchPauseMs);
            }
        }
    }
}

module.exports = {
    DispatchQueue,
};
