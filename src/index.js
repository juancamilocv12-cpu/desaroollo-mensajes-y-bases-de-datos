require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const {
    DEFAULT_API_VERSION,
    sendTemplateMessage,
    sendTextMessage,
    sendRawMessage,
    markMessageAsRead,
    sendMediaMessage,
    sendInteractiveMessage,
    listTemplates,
    uploadMedia,
    extractTemplateRequirements,
    buildTemplateComponentsFromInputs,
    validateTemplateInputs,
    validateSendTemplatePayload,
} = require("./whatsapp");
const { parseExcelRecipients } = require("./excel");
const { DispatchQueue } = require("./queue");
const {
    appendLog,
    saveCampaign,
    getCampaign,
    listCampaigns,
    getLogs,
    getStoreHealth,
    closeStore,
} = require("./store");

const app = express();
const port = Number(process.env.PORT || 3000);
const appBasicAuthUser = process.env.APP_BASIC_AUTH_USER || "MERCADEO";
const appBasicAuthPassword = process.env.APP_BASIC_AUTH_PASSWORD || "MERCADEO2026";
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
});

app.use(express.json({ limit: "1mb" }));

let server;
let shuttingDown = false;

function reportProcessIssue(kind, error) {
    const message = error instanceof Error ? error.message : String(error || kind);
    const stack = error instanceof Error ? error.stack : undefined;

    console.error(`[process:${kind}]`, stack || message);
    try {
        appendLog({
            type: "process_issue",
            status: kind,
            error: message,
            payload: stack ? { stack } : undefined,
        });
    } catch (logError) {
        console.error("No fue posible persistir el fallo de proceso", logError);
    }
}

function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Cierre ordenado iniciado por ${signal}`);

    const finish = () => {
        try {
            closeStore();
        } catch (error) {
            console.error("Error cerrando la base de datos", error);
        }
        process.exit(0);
    };

    if (!server) {
        finish();
        return;
    }

    server.close(() => {
        finish();
    });

    setTimeout(() => {
        console.error("Cierre forzado tras timeout de 10s");
        finish();
    }, 10000).unref();
}

process.on("unhandledRejection", (reason) => {
    reportProcessIssue("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
    reportProcessIssue("uncaughtException", error);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function unauthorized(res) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Meteoro"');
    return res.status(401).json({ ok: false, message: "Autenticacion requerida" });
}

function safeCompare(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function parseBasicAuthHeader(headerValue) {
    if (!headerValue || !headerValue.startsWith("Basic ")) {
        return null;
    }

    try {
        const encoded = headerValue.slice(6).trim();
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 0) {
            return null;
        }
        return {
            username: decoded.slice(0, separator),
            password: decoded.slice(separator + 1),
        };
    } catch (_error) {
        return null;
    }
}

function requiresNoAuth(req) {
    // No auth required for health, webhook, and platform in development
    if (req.path === "/health" || req.path === "/webhook" || req.path === "/platform") {
        return true;
    }
    // Allow platform API calls without auth when coming from localhost (development mode)
    if (process.env.NODE_ENV !== "production" && req.hostname === "localhost") {
        return true;
    }
    return false;
}

app.use((req, res, next) => {
    if (requiresNoAuth(req)) {
        return next();
    }

    const credentials = parseBasicAuthHeader(req.headers.authorization);
    if (!credentials) {
        return unauthorized(res);
    }

    const isValidUser = safeCompare(credentials.username, appBasicAuthUser);
    const isValidPassword = safeCompare(credentials.password, appBasicAuthPassword);
    if (!isValidUser || !isValidPassword) {
        return unauthorized(res);
    }

    return next();
});

function parseMaybeJson(value, fallback = undefined) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    if (typeof value === "object") {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function getAvailableBrands() {
    const brands = [];

    if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
        brands.push({
            key: "marca1",
            label: process.env.WHATSAPP_BRAND1_LABEL || "COMERTEX",
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
            apiVersion: process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION,
            businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
            businessId: process.env.WHATSAPP_BUSINESS_ID,
        });
    }

    if (process.env.WHATSAPP_BRAND2_PHONE_NUMBER_ID && process.env.WHATSAPP_BRAND2_ACCESS_TOKEN) {
        brands.push({
            key: "marca2",
            label: process.env.WHATSAPP_BRAND2_LABEL || "TRU",
            phoneNumberId: process.env.WHATSAPP_BRAND2_PHONE_NUMBER_ID,
            accessToken: process.env.WHATSAPP_BRAND2_ACCESS_TOKEN,
            apiVersion: process.env.WHATSAPP_BRAND2_API_VERSION || process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION,
            businessAccountId: process.env.WHATSAPP_BRAND2_BUSINESS_ACCOUNT_ID,
            businessId: process.env.WHATSAPP_BRAND2_BUSINESS_ID,
        });
    }

    return brands;
}

function getCredentialBag(body = {}) {
    const selectedKey = String(body.brand || "marca1").toLowerCase();
    const brands = getAvailableBrands();
    const selectedBrand = brands.find((item) => item.key === selectedKey) || brands[0] || null;

    const base = selectedBrand || {
        key: "manual",
        label: "Manual",
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        apiVersion: process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION,
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
        businessId: process.env.WHATSAPP_BUSINESS_ID,
    };

    return {
        brand: base.key,
        brandLabel: base.label,
        phoneNumberId: body.phoneNumberId || base.phoneNumberId,
        accessToken: body.accessToken || base.accessToken,
        apiVersion: body.apiVersion || base.apiVersion,
        businessAccountId: body.businessAccountId || base.businessAccountId,
        businessId: body.businessId || base.businessId,
    };
}

function isMessageTemplatesEdgeError(error) {
    return (
        error?.status === 400 &&
        String(error?.message || "").toLowerCase().includes("message_templates")
    );
}

function formatProviderErrorMessage(error, credentials) {
    const baseMessage = error?.message || "Error desconocido";
    const providerMessage = String(error?.response?.error?.message || "");
    const isInvalidMediaId = providerMessage.includes("is not a valid whatsapp business account media attachment ID");

    if (isInvalidMediaId) {
        return baseMessage +
            `. El media_id no pertenece a la marca activa (${credentials?.brandLabel || credentials?.brand || "actual"}). ` +
            `Sube el archivo nuevamente con esa misma marca y usa el nuevo media_id.`;
    }

    return baseMessage;
}

async function listTemplatesWithFallback(credentials) {
    try {
        const result = await listTemplates({
            businessAccountId: credentials.businessAccountId,
            accessToken: credentials.accessToken,
            apiVersion: credentials.apiVersion,
        });
        return { result, sourceId: credentials.businessAccountId, sourceType: "waba" };
    } catch (error) {
        if (!isMessageTemplatesEdgeError(error) || !credentials.businessId) {
            throw error;
        }

        const result = await listTemplates({
            businessAccountId: credentials.businessId,
            accessToken: credentials.accessToken,
            apiVersion: credentials.apiVersion,
        });
        return { result, sourceId: credentials.businessId, sourceType: "business" };
    }
}

function applyRowTemplate(value, row) {
    if (typeof value === "string") {
        return value.replace(/{{\s*([^{}\s]+)\s*}}/g, (_all, key) => {
            const raw = row?.[key];
            return raw === undefined || raw === null ? "" : String(raw);
        });
    }

    if (Array.isArray(value)) {
        return value.map((item) => applyRowTemplate(item, row));
    }

    if (value && typeof value === "object") {
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = applyRowTemplate(v, row);
        }
        return result;
    }

    return value;
}

function validateMessagePayload(message) {
    if (!message || typeof message !== "object") {
        return ["message es obligatorio y debe ser objeto."];
    }

    const errors = [];
    const type = message.type;
    if (!["template", "media", "text"].includes(type)) {
        errors.push("message.type debe ser template, media o text.");
        return errors;
    }

    if (type === "template") {
        if (!message.templateName) {
            errors.push("message.templateName es obligatorio para type=template.");
        }
    }

    if (type === "text") {
        if (!message.text) {
            errors.push("message.text es obligatorio para type=text.");
        }
    }

    if (type === "media") {
        if (!message.mediaType) {
            errors.push("message.mediaType es obligatorio para type=media.");
        }
        if (!message.link && !message.mediaId) {
            errors.push("Para multimedia debes enviar message.link o message.mediaId.");
        }
    }

    return errors;
}

async function sendByMessageType({ to, row, message, credentials }) {
    const hydrated = applyRowTemplate(message, row || {});

    if (hydrated.type === "template") {
        const components = hydrated.templateInputs
            ? buildTemplateComponentsFromInputs(hydrated.templateInputs)
            : (hydrated.components || []);
        return sendTemplateMessage({
            to,
            templateName: hydrated.templateName,
            languageCode: hydrated.languageCode || "es",
            components,
            ...credentials,
        });
    }

    if (hydrated.type === "text") {
        return sendTextMessage({
            to,
            text: hydrated.text,
            previewUrl: hydrated.previewUrl,
            ...credentials,
        });
    }

    return sendMediaMessage({
        to,
        mediaType: hydrated.mediaType,
        link: hydrated.link,
        mediaId: hydrated.mediaId,
        caption: hydrated.caption,
        filename: hydrated.filename,
        ...credentials,
    });
}

app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "whatsapp-template-sender", store: getStoreHealth() });
});

app.get("/brands", (_req, res) => {
    const brands = getAvailableBrands().map((item) => ({
        key: item.key,
        label: item.label,
        phoneNumberId: item.phoneNumberId,
        businessAccountId: item.businessAccountId,
        businessId: item.businessId,
        apiVersion: item.apiVersion,
    }));
    return res.status(200).json({ ok: true, data: brands });
});

app.get("/templates", async (req, res) => {
    try {
        const credentials = getCredentialBag(req.query || {});
        const listed = await listTemplatesWithFallback(credentials);

        return res.status(200).json({
            ok: true,
            brand: credentials.brand,
            sourceType: listed.sourceType,
            sourceId: listed.sourceId,
            data: listed.result,
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.get("/templates/:name/requirements", async (req, res) => {
    try {
        const credentials = getCredentialBag(req.query || {});
        const listed = await listTemplatesWithFallback(credentials);
        const result = listed.result;

        const template = (result.data || []).find((item) => item.name === req.params.name);
        if (!template) {
            return res.status(404).json({ ok: false, message: "Template no encontrada." });
        }

        const requirements = extractTemplateRequirements(template);
        return res.status(200).json({ ok: true, data: requirements, template });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-template-smart", async (req, res) => {
    if (!req.body?.to || !req.body?.templateName) {
        return res.status(400).json({ ok: false, message: "Debes enviar to y templateName." });
    }

    try {
        const credentials = getCredentialBag(req.body || {});
        let requirements = null;
        let selectedTemplateLanguage = req.body.languageCode || "es";
        let validationErrors = [];
        let templateDiscoveryWarning = null;
        let templateCandidates = [];

        try {
            const listed = await listTemplatesWithFallback(credentials);
            const templateList = listed.result;

            templateCandidates = (templateList.data || []).filter((item) => item.name === req.body.templateName);
            if (templateCandidates.length === 0) {
                return res.status(404).json({ ok: false, message: "Template no encontrada." });
            }

            const requestedLang = (req.body.languageCode || "").toLowerCase();
            let template = templateCandidates[0];
            if (requestedLang) {
                const byRequestedLang = templateCandidates.find((item) => String(item.language || "").toLowerCase() === requestedLang);
                if (byRequestedLang) {
                    template = byRequestedLang;
                }
            }

            requirements = extractTemplateRequirements(template);
            selectedTemplateLanguage = template.language || req.body.languageCode || "es";
            validationErrors = validateTemplateInputs(requirements, req.body.templateInputs || {});
        } catch (templateLookupError) {
            const isTemplateEdgeUnavailable = isMessageTemplatesEdgeError(templateLookupError);

            if (!isTemplateEdgeUnavailable) {
                throw templateLookupError;
            }

            templateDiscoveryWarning =
                "No fue posible listar templates con esta marca/token; se hara envio directo sin validacion previa de requisitos.";
        }

        if (validationErrors.length > 0) {
            return res.status(400).json({ ok: false, errors: validationErrors, requirements });
        }

        const components = buildTemplateComponentsFromInputs(req.body.templateInputs || {});
        let result;
        try {
            result = await sendTemplateMessage({
                to: req.body.to,
                templateName: req.body.templateName,
                languageCode: selectedTemplateLanguage,
                components,
                ...credentials,
            });
        } catch (sendError) {
            const code = sendError?.response?.error?.code;
            const msg = String(sendError?.message || "");
            const shouldRetryLang = code === 132001 || msg.includes("Template name does not exist in the translation");

            if (!shouldRetryLang || !templateCandidates.length) {
                throw sendError;
            }

            const fallbackTemplate = templateCandidates.find((item) => String(item.language || "").toLowerCase() !== String(selectedTemplateLanguage || "").toLowerCase());
            if (!fallbackTemplate) {
                throw sendError;
            }

            selectedTemplateLanguage = fallbackTemplate.language || selectedTemplateLanguage;
            requirements = extractTemplateRequirements(fallbackTemplate);
            validationErrors = validateTemplateInputs(requirements, req.body.templateInputs || {});
            if (validationErrors.length > 0) {
                return res.status(400).json({ ok: false, errors: validationErrors, requirements });
            }

            result = await sendTemplateMessage({
                to: req.body.to,
                templateName: req.body.templateName,
                languageCode: selectedTemplateLanguage,
                components,
                ...credentials,
            });

            templateDiscoveryWarning = (templateDiscoveryWarning ? (templateDiscoveryWarning + " ") : "") +
                "Meta rechazo la traduccion solicitada y se reintento con languageCode=" + selectedTemplateLanguage + ".";
        }

        return res.status(200).json({
            ok: true,
            data: result,
            requirements,
            components,
            warning: templateDiscoveryWarning,
        });
    } catch (error) {
        const credentials = getCredentialBag(req.body || {});
        return res.status(error.status || 500).json({
            ok: false,
            message: formatProviderErrorMessage(error, credentials),
            providerResponse: error.response || null,
        });
    }
});

app.post("/media/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ ok: false, message: "Debes enviar un archivo en campo 'file'." });
    }

    try {
        const result = await uploadMedia({
            fileBuffer: req.file.buffer,
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
            ...getCredentialBag(req.body),
        });

        appendLog({
            type: "media_uploaded",
            filename: req.file.originalname,
            mediaId: result.id,
        });

        return res.status(200).json({
            ok: true,
            mediaId: result.id,
            mimeType: req.file.mimetype,
            filename: req.file.originalname,
            data: result,
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-template", async (req, res) => {
    const errors = validateSendTemplatePayload(req.body);

    if (errors.length > 0) {
        return res.status(400).json({
            ok: false,
            errors,
        });
    }

    try {
        const result = await sendTemplateMessage({
            to: req.body.to,
            templateName: req.body.templateName,
            languageCode: req.body.languageCode || "es",
            components: req.body.components,
            phoneNumberId: req.body.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
            accessToken: req.body.accessToken || process.env.WHATSAPP_ACCESS_TOKEN,
            apiVersion: req.body.apiVersion || process.env.WHATSAPP_API_VERSION,
        });

        return res.status(200).json({
            ok: true,
            provider: "whatsapp-cloud-api",
            data: result,
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-text", async (req, res) => {
    if (!req.body?.to || !req.body?.text) {
        return res.status(400).json({
            ok: false,
            message: "Debes enviar to y text.",
        });
    }

    try {
        const result = await sendTextMessage({
            to: req.body.to,
            text: req.body.text,
            previewUrl: req.body.previewUrl,
            ...getCredentialBag(req.body),
        });

        return res.status(200).json({ ok: true, provider: "whatsapp-cloud-api", data: result });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-media", async (req, res) => {
    if (!req.body?.to || !req.body?.mediaType) {
        return res.status(400).json({
            ok: false,
            message: "Debes enviar to y mediaType.",
        });
    }

    try {
        const result = await sendMediaMessage({
            to: req.body.to,
            mediaType: req.body.mediaType,
            link: req.body.link,
            mediaId: req.body.mediaId,
            caption: req.body.caption,
            filename: req.body.filename,
            ...getCredentialBag(req.body),
        });

        return res.status(200).json({ ok: true, provider: "whatsapp-cloud-api", data: result });
    } catch (error) {
        const credentials = getCredentialBag(req.body || {});
        return res.status(error.status || 500).json({
            ok: false,
            message: formatProviderErrorMessage(error, credentials),
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-message", async (req, res) => {
    try {
        const result = await sendRawMessage({
            rawMessage: req.body,
            ...getCredentialBag(req.body),
        });

        return res.status(200).json({ ok: true, provider: "whatsapp-cloud-api", data: result });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/send-interactive", async (req, res) => {
    if (!req.body?.to || !req.body?.interactive) {
        return res.status(400).json({
            ok: false,
            message: "Debes enviar to e interactive.",
        });
    }

    try {
        const result = await sendInteractiveMessage({
            to: req.body.to,
            interactive: req.body.interactive,
            ...getCredentialBag(req.body),
        });

        return res.status(200).json({ ok: true, provider: "whatsapp-cloud-api", data: result });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/messages/mark-read", async (req, res) => {
    try {
        const result = await markMessageAsRead({
            messageId: req.body?.messageId,
            ...getCredentialBag(req.body),
        });

        return res.status(200).json({ ok: true, provider: "whatsapp-cloud-api", data: result });
    } catch (error) {
        return res.status(error.status || 500).json({
            ok: false,
            message: error.message,
            providerResponse: error.response || null,
        });
    }
});

app.post("/campaigns/from-excel", upload.single("file"), async (req, res) => {
    const message = parseMaybeJson(req.body.message, req.body.message);
    const antiSpam = parseMaybeJson(req.body.antiSpam, req.body.antiSpam) || {};
    const startAtRaw = req.body.startAt;
    const startAt = startAtRaw ? new Date(startAtRaw) : null;
    const errors = validateMessagePayload(message);

    if (startAt && Number.isNaN(startAt.getTime())) {
        errors.push("startAt no tiene formato de fecha valido.");
    }

    if (errors.length > 0) {
        return res.status(400).json({ ok: false, errors });
    }

    try {
        const recipients = await parseExcelRecipients({
            buffer: req.file?.buffer,
            filePath: req.body.filePath,
            sheetName: req.body.sheetName,
            phoneColumn: req.body.phoneColumn,
        });

        if (recipients.length === 0) {
            return res.status(400).json({
                ok: false,
                message: "No se encontraron telefonos validos en el Excel.",
            });
        }

        const campaignId = crypto.randomUUID();
        const campaign = {
            id: campaignId,
            createdAt: new Date().toISOString(),
            baseReference: req.body.baseReference ? String(req.body.baseReference).trim().slice(0, 60) : undefined,
            startAt: startAt ? startAt.toISOString() : new Date().toISOString(),
            status: startAt && startAt.getTime() > Date.now() ? "scheduled" : "running",
            messageType: message.type,
            total: recipients.length,
            sent: 0,
            failed: 0,
            processed: 0,
            antiSpam: {
                timingMs: Number(antiSpam.timingMs || 1200),
                batchSize: Number(antiSpam.batchSize || 25),
                batchPauseMs: Number(antiSpam.batchPauseMs || 20000),
                maxRetries: Number(antiSpam.maxRetries || 2),
                retryDelayMs: Number(antiSpam.retryDelayMs || 2500),
                jitterMs: Number(antiSpam.jitterMs || 300),
            },
        };

        saveCampaign(campaign);

        const runCampaign = async () => {
            const current = getCampaign(campaignId);
            if (!current) {
                return;
            }

            current.status = "running";
            saveCampaign(current);

            const queue = new DispatchQueue(current.antiSpam);
            const credentials = getCredentialBag(req.body);

            await queue.run({
                recipients,
                worker: async (recipient) => {
                    return sendByMessageType({
                        to: recipient.to,
                        row: recipient.row,
                        message,
                        credentials,
                    });
                },
                onProgress: (progress) => {
                    const draft = getCampaign(campaignId);
                    if (!draft) {
                        return;
                    }

                    draft.processed = progress.processed;
                    if (progress.status === "success") {
                        draft.sent += 1;
                    } else {
                        draft.failed += 1;
                    }

                    if (draft.processed === draft.total) {
                        draft.status = draft.failed > 0 ? "completed_with_errors" : "completed";
                        draft.completedAt = new Date().toISOString();
                    }

                    saveCampaign(draft);
                    appendLog({
                        campaignId,
                        type: "campaign_progress",
                        to: progress.recipient?.to,
                        status: progress.status,
                        attempt: progress.attempt,
                        error: progress.error ? progress.error.message : undefined,
                    });
                },
            });
        };

        if (startAt && startAt.getTime() > Date.now()) {
            const delay = startAt.getTime() - Date.now();
            setTimeout(() => {
                runCampaign().catch((error) => {
                    const draft = getCampaign(campaignId);
                    if (draft) {
                        draft.status = "failed";
                        draft.error = error.message;
                        saveCampaign(draft);
                    }
                });
            }, delay);
        } else {
            runCampaign().catch((error) => {
                const draft = getCampaign(campaignId);
                if (draft) {
                    draft.status = "failed";
                    draft.error = error.message;
                    saveCampaign(draft);
                }
            });
        }

        return res.status(202).json({
            ok: true,
            message: "Campana creada",
            campaign,
        });
    } catch (error) {
        return res.status(400).json({
            ok: false,
            message: error.message,
        });
    }
});

app.get("/campaigns", (_req, res) => {
    return res.json({ ok: true, data: listCampaigns() });
});

app.get("/campaigns/:id", (req, res) => {
    const campaign = getCampaign(req.params.id);
    if (!campaign) {
        return res.status(404).json({ ok: false, message: "Campana no encontrada" });
    }
    return res.json({ ok: true, data: campaign });
});

app.get("/logs", (req, res) => {
    const limit = Number(req.query.limit || 200);
    return res.json({ ok: true, data: getLogs(limit) });
});

app.get("/platform", (_req, res) => {
    const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Meteoro by Comertex</title>
    <style>
            @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap');
            :root {
                color-scheme: dark;
                --bg:#040714;
                --bg-2:#0a1430;
                --card:rgba(12, 20, 48, 0.52);
                --ink:#e9f1ff;
                --muted:#9cb0d3;
                --line:rgba(145, 178, 255, 0.28);
                --accent:#52d6ff;
                --accent-soft:rgba(82, 214, 255, 0.16);
                --accent-2:#f7a24f;
                --danger:#ff6b6b;
                --ok:#73f0bd;
                --shadow:0 16px 40px rgba(0, 0, 0, 0.34);
            }
            * { box-sizing:border-box; }
            body {
                margin:0;
                font-family:'Manrope', sans-serif;
                color:var(--ink);
                background:
                    radial-gradient(circle at 15% 18%, rgba(103, 80, 255, 0.24) 0, rgba(103, 80, 255, 0) 32%),
                    radial-gradient(circle at 82% 6%, rgba(82, 214, 255, 0.26) 0, rgba(82, 214, 255, 0) 30%),
                    radial-gradient(circle at 74% 74%, rgba(247, 162, 79, 0.15) 0, rgba(247, 162, 79, 0) 34%),
                    linear-gradient(160deg, var(--bg) 0%, var(--bg-2) 100%);
            }
            body::before {
                content:'';
                position:fixed;
                inset:0;
                pointer-events:none;
                opacity:.5;
                background-image:
                    radial-gradient(2px 2px at 10% 20%, rgba(255,255,255,.85), transparent 60%),
                    radial-gradient(1.5px 1.5px at 25% 68%, rgba(210,233,255,.8), transparent 60%),
                    radial-gradient(2px 2px at 64% 30%, rgba(255,255,255,.76), transparent 60%),
                    radial-gradient(1.5px 1.5px at 75% 80%, rgba(219,241,255,.74), transparent 60%),
                    radial-gradient(2px 2px at 88% 16%, rgba(255,255,255,.75), transparent 60%),
                    radial-gradient(1.5px 1.5px at 42% 48%, rgba(198,226,255,.68), transparent 60%);
            }
            .wrap {
                max-width: 1260px;
                margin: 28px auto;
                padding: 0 18px 28px;
                position:relative;
                isolation:isolate;
            }
            .constellation-bg {
                position:absolute;
                inset:0;
                z-index:0;
                pointer-events:none;
                opacity:.32;
                background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 1200'%3E%3Cg stroke='%238db6ff' stroke-opacity='0.28' stroke-width='1.3'%3E%3Cline x1='120' y1='210' x2='250' y2='160'/%3E%3Cline x1='250' y1='160' x2='380' y2='220'/%3E%3Cline x1='980' y1='190' x2='1080' y2='250'/%3E%3Cline x1='1080' y1='250' x2='1210' y2='210'/%3E%3Cline x1='520' y1='760' x2='640' y2='690'/%3E%3Cline x1='640' y1='690' x2='770' y2='760'/%3E%3Cline x1='1270' y1='760' x2='1380' y2='700'/%3E%3Cline x1='1380' y1='700' x2='1490' y2='780'/%3E%3C/g%3E%3Cg fill='%23dbeafe' fill-opacity='0.85'%3E%3Ccircle cx='120' cy='210' r='2.3'/%3E%3Ccircle cx='250' cy='160' r='2.9'/%3E%3Ccircle cx='380' cy='220' r='2.1'/%3E%3Ccircle cx='980' cy='190' r='2.5'/%3E%3Ccircle cx='1080' cy='250' r='3.1'/%3E%3Ccircle cx='1210' cy='210' r='2.2'/%3E%3Ccircle cx='520' cy='760' r='2.4'/%3E%3Ccircle cx='640' cy='690' r='3.0'/%3E%3Ccircle cx='770' cy='760' r='2.1'/%3E%3Ccircle cx='1270' cy='760' r='2.4'/%3E%3Ccircle cx='1380' cy='700' r='2.8'/%3E%3Ccircle cx='1490' cy='780' r='2.0'/%3E%3C/g%3E%3C/svg%3E");
                background-size:cover;
                background-repeat:no-repeat;
                animation: driftStars 32s linear infinite;
            }
            .wrap > *:not(.constellation-bg) { position:relative; z-index:1; }
            .hero {
                border:1px solid var(--line);
                border-radius:20px;
                padding:20px;
                background:linear-gradient(120deg, rgba(23, 37, 84, 0.72) 0%, rgba(12, 25, 55, 0.72) 50%, rgba(8, 34, 60, 0.7) 100%);
                box-shadow: var(--shadow);
                margin-bottom:16px;
                position:relative;
                overflow:hidden;
            }
            .brand-eyebrow {
                margin:0 0 8px;
                font-size:11px;
                text-transform:uppercase;
                letter-spacing:.18em;
                color:#94b7e8;
                font-weight:700;
            }
            .brand-title {
                display:flex;
                align-items:flex-end;
                gap:12px;
                margin:0 0 8px;
            }
            .brand-mark {
                width:34px;
                height:34px;
                border-radius:10px;
                border:1px solid rgba(160, 211, 255, .35);
                background:linear-gradient(140deg, rgba(82,214,255,.24) 0%, rgba(132,150,255,.22) 100%);
                display:flex;
                align-items:center;
                justify-content:center;
                box-shadow:0 6px 16px rgba(46, 149, 255, .22);
                margin-bottom:4px;
            }
            .brand-mark svg { width:20px; height:20px; }
            .hero::after {
                content:'';
                position:absolute;
                right:-40px;
                top:-40px;
                width:220px;
                height:220px;
                border-radius:50%;
                background:radial-gradient(circle, rgba(82,214,255,.34) 0, rgba(82,214,255,0) 70%);
                pointer-events:none;
            }
            .hero .orbit {
                position:absolute;
                width:170px;
                height:170px;
                border:1px solid rgba(148, 197, 255, .26);
                border-radius:50%;
                right:24px;
                top:20px;
                animation: spinOrbit 14s linear infinite;
                pointer-events:none;
            }
            .hero .orbit::before {
                content:'';
                position:absolute;
                width:10px;
                height:10px;
                border-radius:50%;
                background:#8df1ff;
                left:50%;
                top:-5px;
                transform:translateX(-50%);
                box-shadow:0 0 14px rgba(141,241,255,.9);
            }
            .hero .orbit.orbit-2 {
                width:230px;
                height:230px;
                right:-6px;
                top:-8px;
                animation-duration:22s;
                animation-direction:reverse;
                border-color:rgba(247, 162, 79, .24);
            }
            .hero .orbit.orbit-2::before {
                background:#ffd39b;
                box-shadow:0 0 14px rgba(255,211,155,.75);
                width:8px;
                height:8px;
                top:-4px;
            }
            .hero h1 {
                margin:0;
                font-family:'Plus Jakarta Sans', sans-serif;
                font-size:42px;
                letter-spacing:-.04em;
                line-height:1.03;
                font-weight:800;
                color:#ffffff;
                text-shadow:0 8px 30px rgba(52, 154, 255, .24);
                display:flex;
                flex-wrap:wrap;
                align-items:flex-end;
                gap:10px;
            }
            .hero h1 .brand-main {
                background:linear-gradient(120deg, #ffffff 0%, #bde6ff 48%, #88d6ff 100%);
                -webkit-background-clip:text;
                background-clip:text;
                color:transparent;
            }
            .hero h1 .brand-sub {
                font-size:15px;
                letter-spacing:.08em;
                text-transform:uppercase;
                color:#a9c9f6;
                font-weight:600;
                transform:translateY(-2px);
            }
            .hero p { margin:0; color:var(--muted); }
            .steps { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
            .step {
                background:rgba(255,255,255,.06);
                border:1px solid rgba(169,198,255,.34);
                border-radius:999px;
                padding:6px 12px;
                font-size:12px;
                color:#c9dcff;
                font-weight:600;
            }
            .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:18px; margin-bottom:18px; }
            .card {
                background: var(--card);
                border: 1px solid var(--line);
                border-radius: 20px;
                padding: 18px;
                box-shadow: var(--shadow);
                overflow: visible;
                position:relative;
                transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
            }
            .card::before {
                content:'';
                position:absolute;
                left:16px;
                right:16px;
                top:0;
                height:1px;
                background:linear-gradient(90deg, rgba(82,214,255,.0), rgba(82,214,255,.6), rgba(82,214,255,.0));
                opacity:.55;
            }
            .card:hover {
                transform: translateY(-1px);
                border-color: rgba(145, 178, 255, 0.44);
                box-shadow: 0 20px 44px rgba(0,0,0,.36);
            }
            .card h3 {
                margin:0 0 12px;
                font-family:'Plus Jakarta Sans', sans-serif;
                font-size:18px;
                letter-spacing:.01em;
                font-weight:700;
            }
            .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
            .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
            p { margin: 0 0 10px; line-height:1.45; }
            label { font-size:13px; font-weight:700; color:#cddcff; display:block; margin-bottom:5px; }
            input, select, textarea, button {
                width:100%;
                border:1px solid var(--line);
                border-radius:11px;
                padding:11px 12px;
                font: inherit;
            }
            input, select, textarea {
                background:rgba(255,255,255,.06);
                color:var(--ink);
            }
            select {
                appearance:auto;
                -webkit-appearance: menulist;
                cursor:pointer;
                position:static;
                z-index:auto;
                pointer-events:auto;
                padding-right:12px;
                background-image:none;
            }
            option {
                background:#0a1430;
                color:#e9f1ff;
            }
            input::placeholder, textarea::placeholder { color:#93a6cb; }
            input:focus, select:focus, textarea:focus {
                outline:none;
                border-color: rgba(82,214,255,.8);
                box-shadow:0 0 0 3px rgba(82,214,255,.15);
            }
            textarea { min-height: 90px; resize: vertical; }
            button {
                border:none;
                cursor:pointer;
                font-weight:700;
                background:linear-gradient(120deg, #2fa3ff 0%, #42d7ff 100%);
                color:#05203b;
                transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
            }
            button:hover { transform: translateY(-1px); box-shadow:0 8px 20px rgba(66,215,255,.32); filter:brightness(1.04); }
            button.secondary {
                background:rgba(255,255,255,.04);
                color:#d8e7ff;
                border:1px solid rgba(154,186,250,.38);
            }
            button.warn { background:linear-gradient(120deg, #f59d3a 0%, #ffb86b 100%); color:#2c1700; }
            table { width:100%; border-collapse: collapse; font-size: 14px; border-radius:10px; overflow:hidden; }
            th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); }
            th { color:#b8cdf7; font-size:11px; text-transform:uppercase; letter-spacing:.06em; background:rgba(255,255,255,.03); }
            tbody tr:hover { background:rgba(255,255,255,.03); }
            .muted { color: var(--muted); }
            .badge { padding: 2px 10px; border-radius: 999px; background:var(--accent-soft); color: #8de7ff; font-weight: 700; }
            .ok { color: var(--ok); font-weight: 700; }
            .err { color: var(--danger); font-weight: 700; }
            .mb { margin-bottom:12px; }
            .section { margin-bottom: 16px; }
            .builder-group {
                border: 1px dashed var(--line);
                border-radius: 12px;
                padding: 10px;
                margin-bottom: 8px;
                background:rgba(255,255,255,.04);
            }
            .builder-group h4 { margin: 0 0 8px; font-size: 13px; color: var(--muted); letter-spacing: .02em; }
            .helper {
                margin:0 0 10px;
                padding:8px 10px;
                background:rgba(56, 189, 248, 0.1);
                border:1px solid rgba(125, 211, 252, 0.3);
                border-radius:10px;
                font-size:12px;
                color:#c7ddff;
            }
            .pill-row { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
            .pill {
                border:1px solid var(--line);
                background:rgba(255,255,255,.05);
                border-radius:999px;
                font-size:11px;
                padding:5px 9px;
                color:#d4e2ff;
                font-weight:600;
            }
            .mini { font-size:12px; }
            .top-nav {
                display:flex;
                gap:8px;
                margin: 0 0 14px;
                flex-wrap:wrap;
                position:relative;
                z-index:1;
                padding:9px;
                border:1px solid rgba(145, 178, 255, 0.24);
                border-radius:16px;
                background:rgba(7, 13, 31, 0.58);
            }
            .top-nav button {
                width:auto;
                padding:10px 15px;
                border-radius:999px;
                background:rgba(255,255,255,.04);
                color:#d4e5ff;
                border:1px solid var(--line);
                box-shadow:none;
            }
            .top-nav button.active {
                background:linear-gradient(120deg, #2fa3ff 0%, #42d7ff 100%);
                color:#05203b;
                border-color:#61dfff;
            }
            .top-nav button.secondary-toggle {
                margin-left:auto;
            }
            .flow-toolbar {
                display:flex;
                gap:10px;
                align-items:center;
                margin:0 0 12px;
                flex-wrap:wrap;
            }
            .flow-steps {
                display:flex;
                gap:6px;
                flex-wrap:wrap;
                flex:1;
            }
            .flow-chip {
                border:1px solid rgba(145, 178, 255, 0.34);
                border-radius:999px;
                padding:6px 10px;
                font-size:12px;
                background:rgba(255,255,255,.04);
                color:#d8e7ff;
                cursor:pointer;
                display:inline-flex;
                align-items:center;
                gap:7px;
            }
            .flow-chip.active {
                background:linear-gradient(120deg, #2fa3ff 0%, #42d7ff 100%);
                color:#05203b;
                border-color:#61dfff;
            }
            .flow-chip.active .astro-dot {
                animation: astroPulse 1.6s ease-in-out infinite;
                filter:brightness(1.25);
            }
            .astro-dot {
                width:10px;
                height:10px;
                border-radius:50%;
                position:relative;
                flex:0 0 auto;
            }
            .astro-meteor {
                background:#9ee8ff;
                box-shadow:0 0 10px rgba(158,232,255,.72);
            }
            .astro-meteor::after {
                content:'';
                position:absolute;
                width:10px;
                height:2px;
                border-radius:4px;
                background:linear-gradient(90deg, rgba(158,232,255,.85), rgba(158,232,255,0));
                right:8px;
                top:4px;
                transform:rotate(-20deg);
            }
            .astro-sun {
                background:radial-gradient(circle, #ffe8b2 0%, #ffb84f 65%, #ff8f2f 100%);
                box-shadow:0 0 10px rgba(255,184,79,.72);
            }
            .astro-moon {
                background:#cddcf9;
                box-shadow:inset -3px 0 0 rgba(117, 146, 194, .72), 0 0 8px rgba(193,214,255,.52);
            }
            .astro-planet {
                background:#99f0c4;
                box-shadow:0 0 10px rgba(153,240,196,.62);
            }
            .astro-planet::after {
                content:'';
                position:absolute;
                width:14px;
                height:4px;
                border:1px solid rgba(171,255,221,.8);
                border-radius:999px;
                left:-3px;
                top:2px;
                transform:rotate(-18deg);
                background:transparent;
            }
            .astro-star {
                background:linear-gradient(135deg, #b7dcff 0%, #7ad0ff 100%);
                transform:rotate(45deg);
                border-radius:2px;
                box-shadow:0 0 10px rgba(122,208,255,.62);
            }
            .astro-star::after {
                content:'';
                position:absolute;
                inset:0;
                background:inherit;
                border-radius:2px;
                transform:rotate(90deg);
            }
            .astro-guide-fab {
                position:fixed;
                right:16px;
                bottom:16px;
                z-index:9998;
                width:auto;
                border-radius:999px;
                padding:10px 14px;
                border:1px solid rgba(145,178,255,.38);
                background:linear-gradient(120deg, rgba(46,163,255,.95), rgba(66,215,255,.95));
                color:#06253d;
                font-weight:700;
                box-shadow:0 12px 24px rgba(0,0,0,.28);
            }
            .astro-guide-panel {
                position:fixed;
                right:16px;
                bottom:68px;
                width:min(420px, calc(100vw - 24px));
                z-index:9998;
                border:1px solid rgba(145,178,255,.35);
                border-radius:14px;
                background:rgba(4, 10, 26, .94);
                box-shadow:0 14px 34px rgba(0,0,0,.34);
                padding:12px;
                color:#dcedff;
            }
            .astro-guide-panel.hidden { display:none; }
            .astro-guide-panel h4 {
                margin:0 0 8px;
                font-size:16px;
                color:#e7f4ff;
            }
            .astro-guide-head {
                display:flex;
                gap:10px;
                align-items:center;
                margin-bottom:6px;
            }
            .astro-mascot {
                width:40px;
                height:40px;
                border-radius:12px;
                border:1px solid rgba(145,178,255,.4);
                background:linear-gradient(145deg, rgba(78,147,255,.3), rgba(122,208,255,.18));
                display:flex;
                align-items:center;
                justify-content:center;
                box-shadow:0 8px 18px rgba(0,0,0,.3);
                flex:0 0 auto;
            }
            .astro-mascot svg { width:24px; height:24px; }
            .astro-guide-panel p {
                margin:0 0 8px;
                color:#a9c4ea;
                font-size:12px;
            }
            .astro-guide-list {
                margin:0;
                padding-left:16px;
                display:grid;
                gap:6px;
                font-size:12px;
                color:#d7e9ff;
            }
            .astro-guide-context {
                border:1px dashed rgba(145,178,255,.35);
                border-radius:10px;
                padding:8px;
                margin-bottom:8px;
                background:rgba(255,255,255,.03);
                color:#bfe0ff;
                font-size:12px;
            }
            .astro-guide-actions {
                margin-top:10px;
                display:flex;
                justify-content:flex-end;
                gap:8px;
            }
            .astro-guide-actions button { width:auto; padding:8px 12px; }
            .flow-controls { display:flex; gap:8px; }
            .flow-controls button { width:auto; padding:9px 12px; }
            .flow-progress {
                width:100%;
                height:6px;
                border-radius:999px;
                background:rgba(255,255,255,.08);
                border:1px solid rgba(145,178,255,.25);
                overflow:hidden;
                margin-top:4px;
            }
            .flow-progress-fill {
                width:0%;
                height:100%;
                background:linear-gradient(90deg, rgba(82,214,255,.9) 0%, rgba(158,245,196,.9) 100%);
                box-shadow:0 0 10px rgba(82,214,255,.45);
                transition:width .24s ease;
            }
            .flow-swipe-hint {
                font-size:11px;
                color:var(--muted);
                margin-left:6px;
            }
            .astro-bar {
                display:flex;
                gap:8px;
                flex-wrap:wrap;
                margin:0 0 12px;
            }
            .astro-pill {
                display:flex;
                gap:8px;
                align-items:center;
                border:1px solid rgba(145,178,255,.3);
                border-radius:999px;
                padding:7px 12px;
                background:rgba(255,255,255,.05);
                color:#d5e8ff;
                font-size:12px;
            }
            .astro-pill span { color:#a9c4ea; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
            .astro-pill b { font-weight:700; color:#e6f5ff; }
            .brand-meta {
                display:grid;
                grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
                gap:8px;
                margin-top:10px;
            }
            .brand-id-card {
                border:1px solid rgba(145,178,255,.26);
                border-radius:10px;
                padding:8px;
                background:rgba(255,255,255,.04);
            }
            .brand-id-card label {
                font-size:11px;
                letter-spacing:.05em;
                text-transform:uppercase;
                color:#9db6dd;
                margin:0 0 4px;
            }
            .brand-id-row { display:flex; gap:6px; align-items:center; }
            .brand-id-value {
                flex:1;
                font-size:12px;
                color:#d9ebff;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                padding:6px 8px;
                border-radius:8px;
                background:rgba(2, 6, 23, .36);
                border:1px solid rgba(145,178,255,.22);
            }
            .mini-copy {
                width:auto;
                padding:6px 10px;
                font-size:11px;
            }
            .pipeline-mini {
                display:flex;
                gap:8px;
                flex-wrap:wrap;
                margin:0 0 10px;
                align-items:center;
            }
            .pipeline-node {
                border:1px solid rgba(145,178,255,.3);
                border-radius:999px;
                padding:6px 10px;
                font-size:12px;
                color:#d7e8ff;
                background:rgba(255,255,255,.04);
                position:relative;
                animation: nodeGlow 2.8s ease-in-out infinite;
            }
            .pipeline-node:not(:last-child)::after {
                content:'';
                width:18px;
                height:1px;
                background:linear-gradient(90deg, rgba(125,211,252,.5), rgba(125,211,252,.15));
                position:absolute;
                right:-20px;
                top:50%;
                transform:translateY(-50%);
            }
            .send-template-grid .card {
                border-color:rgba(120, 185, 255, .35);
            }
            .schedule-box {
                border:1px dashed rgba(145,178,255,.34);
                border-radius:12px;
                padding:10px;
                background:rgba(255,255,255,.04);
            }
            .schedule-quick {
                display:flex;
                gap:6px;
                flex-wrap:wrap;
                margin-bottom:8px;
            }
            .schedule-quick button { width:auto; padding:7px 10px; font-size:12px; }
            .schedule-display {
                display:flex;
                gap:8px;
                align-items:center;
                margin-bottom:8px;
            }
            .schedule-display .tag {
                flex:1;
                padding:8px 10px;
                border-radius:10px;
                border:1px solid rgba(145,178,255,.3);
                background:rgba(2, 6, 23, .35);
                color:#d9ecff;
                font-size:12px;
            }
            .schedule-popover {
                border:1px solid rgba(145,178,255,.35);
                border-radius:10px;
                padding:10px;
                background:rgba(3, 9, 25, .92);
                margin-bottom:8px;
            }
            .schedule-popover .row { align-items:flex-end; }
            .schedule-popover.hidden { display:none; }
            .solar-scheduler {
                margin:8px 0 10px;
                border:1px solid rgba(145,178,255,.28);
                border-radius:12px;
                background:radial-gradient(circle at 50% 40%, rgba(40,70,140,.22) 0, rgba(5,10,24,.5) 60%, rgba(5,10,24,.82) 100%);
                padding:10px;
                position:relative;
                overflow:hidden;
            }
            .solar-stage {
                width:150px;
                height:150px;
                margin:0 auto;
                position:relative;
            }
            .solar-core {
                width:20px;
                height:20px;
                border-radius:50%;
                background:radial-gradient(circle, #ffe5a8 0, #ffb648 58%, #ff8a00 100%);
                box-shadow:0 0 24px rgba(255,182,72,.65);
                position:absolute;
                left:50%;
                top:50%;
                transform:translate(-50%, -50%);
            }
            .solar-orbit {
                position:absolute;
                left:50%;
                top:50%;
                transform:translate(-50%, -50%);
                border:1px solid rgba(148, 197, 255, .22);
                border-radius:50%;
            }
            .solar-orbit-1 { width:62px; height:62px; }
            .solar-orbit-2 { width:98px; height:98px; }
            .solar-orbit-3 { width:132px; height:132px; }
            .solar-arm {
                width:100%;
                height:100%;
                position:relative;
                transform:rotate(0deg);
                transition:transform .32s ease;
            }
            .solar-planet {
                width:10px;
                height:10px;
                border-radius:50%;
                position:absolute;
                left:50%;
                top:-5px;
                transform:translateX(-50%);
                background:#8dd8ff;
                box-shadow:0 0 10px rgba(141,216,255,.7);
            }
            .solar-planet.accent {
                width:12px;
                height:12px;
                top:-6px;
                background:#9ef5c4;
                box-shadow:0 0 14px rgba(158,245,196,.72);
            }
            .solar-label {
                margin-top:6px;
                text-align:center;
                font-size:12px;
                color:#b8d6ff;
            }
            .schedule-window-status {
                margin-top:8px;
                font-size:12px;
                color:#a6cbff;
            }
            .kpi-strip {
                display:grid;
                grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
                gap:10px;
                margin:0 0 12px;
            }
            .kpi-card {
                border:1px solid rgba(145, 178, 255, 0.28);
                border-radius:12px;
                padding:10px 12px;
                background:rgba(255,255,255,.04);
            }
            .kpi-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
            .kpi-value { font-size:22px; font-weight:700; color:#dff3ff; margin-top:4px; }
            .empty-state {
                text-align:center;
                padding:18px 12px;
                color:var(--muted);
                font-size:13px;
            }
            .toast-wrap {
                position:fixed;
                right:16px;
                top:16px;
                z-index:9999;
                display:flex;
                flex-direction:column;
                gap:8px;
                pointer-events:none;
            }
            .toast {
                min-width:240px;
                max-width:360px;
                border:1px solid rgba(145,178,255,.3);
                border-radius:10px;
                padding:10px 12px;
                background:rgba(7,13,31,.9);
                color:#d9ebff;
                box-shadow:0 10px 26px rgba(0,0,0,.28);
                animation: flowSlide .16s ease-out;
            }
            .toast.ok { border-color:rgba(115,240,189,.5); }
            .toast.err { border-color:rgba(255,107,107,.5); }
            .calendar-shell {
                display:grid;
                grid-template-columns:minmax(0, 1.6fr) minmax(280px, .9fr);
                gap:12px;
            }
            .calendar-toolbar {
                display:flex;
                gap:8px;
                align-items:center;
                flex-wrap:wrap;
                margin-bottom:10px;
            }
            .calendar-title {
                font-size:20px;
                font-weight:800;
                letter-spacing:.02em;
                color:#e6f5ff;
                margin-right:auto;
            }
            .calendar-legend {
                display:flex;
                gap:8px;
                flex-wrap:wrap;
                margin:0 0 10px;
            }
            .calendar-legend span {
                font-size:11px;
                border:1px solid rgba(145,178,255,.3);
                border-radius:999px;
                padding:5px 9px;
                color:#cbe3ff;
                background:rgba(255,255,255,.04);
            }
            .calendar-grid {
                display:grid;
                grid-template-columns:repeat(7, minmax(0, 1fr));
                gap:8px;
            }
            .calendar-weekday {
                text-align:center;
                font-size:11px;
                color:#98b8df;
                letter-spacing:.07em;
                text-transform:uppercase;
            }
            .calendar-day {
                min-height:92px;
                border:1px solid rgba(145,178,255,.28);
                border-radius:12px;
                background:linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
                padding:8px;
                cursor:pointer;
                overflow:hidden;
                transition:border-color .2s ease, transform .2s ease, box-shadow .2s ease;
            }
            .calendar-day:hover {
                border-color:rgba(158,245,196,.5);
                transform:translateY(-1px);
                box-shadow:0 8px 16px rgba(0,0,0,.2);
            }
            .calendar-day.muted {
                opacity:.45;
            }
            .calendar-day.today {
                border-color:rgba(94,204,255,.75);
            }
            .calendar-day.active {
                border-color:rgba(158,245,196,.85);
                box-shadow:0 0 0 1px rgba(158,245,196,.32) inset;
            }
            .calendar-day-head {
                display:flex;
                align-items:center;
                justify-content:space-between;
                font-size:12px;
                color:#dff2ff;
            }
            .calendar-count {
                font-size:11px;
                border-radius:999px;
                border:1px solid rgba(145,178,255,.33);
                padding:2px 6px;
                color:#bde2ff;
            }
            .calendar-items {
                margin-top:6px;
                display:grid;
                gap:4px;
            }
            .calendar-mini {
                font-size:11px;
                padding:4px 6px;
                border-radius:8px;
                background:rgba(255,255,255,.05);
                color:#d9ebff;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
            }
            .calendar-mini.status-scheduled { border-left:2px solid #8dd8ff; }
            .calendar-mini.status-running { border-left:2px solid #9ef5c4; }
            .calendar-mini.status-completed { border-left:2px solid #8bc34a; }
            .calendar-mini.status-failed,
            .calendar-mini.status-error { border-left:2px solid #ff8f8f; }
            .calendar-day-actions {
                margin-top:6px;
                display:grid;
                grid-template-columns:minmax(0, 1fr) 32px;
                gap:5px;
                align-items:center;
                width:100%;
            }
            .calendar-time {
                width:100%;
                min-width:0;
                max-width:100%;
                border:1px solid rgba(145,178,255,.28);
                border-radius:8px;
                background:rgba(2, 6, 23, .35);
                color:#d9ebff;
                font-size:10px;
                line-height:1.1;
                padding:4px 4px;
                letter-spacing:-.02em;
            }
            .calendar-time::-webkit-date-and-time-value {
                text-align:left;
                min-height:auto;
            }
            .calendar-time::-webkit-datetime-edit,
            .calendar-time::-webkit-datetime-edit-fields-wrapper {
                padding:0;
            }
            .calendar-time::-webkit-calendar-picker-indicator {
                margin:0;
                opacity:.72;
                transform:scale(.82);
            }
            .calendar-plan-btn {
                width:32px;
                min-width:32px;
                padding:5px 0;
                font-size:11px;
                line-height:1;
            }
            .calendar-side {
                border:1px solid rgba(145,178,255,.28);
                border-radius:12px;
                padding:12px;
                background:rgba(255,255,255,.035);
                display:flex;
                flex-direction:column;
                gap:10px;
            }
            .calendar-side h4 {
                margin:0;
                color:#e6f5ff;
                font-size:17px;
            }
            .calendar-agenda {
                max-height:420px;
                overflow:auto;
                display:grid;
                gap:8px;
                padding-right:4px;
            }
            .calendar-event {
                border:1px solid rgba(145,178,255,.28);
                border-radius:10px;
                padding:8px;
                background:rgba(2, 6, 23, .3);
            }
            .calendar-event-head {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:4px;
            }
            .calendar-event-time { color:#dff3ff; font-size:12px; font-weight:700; }
            .calendar-event-meta { font-size:12px; color:#afcbef; }
            .calendar-empty {
                border:1px dashed rgba(145,178,255,.3);
                border-radius:10px;
                padding:12px;
                color:#9bbde3;
                text-align:center;
                font-size:12px;
            }
            .calendar-modal {
                position:fixed;
                inset:0;
                z-index:9997;
                display:none;
                align-items:center;
                justify-content:center;
                background:rgba(2, 8, 20, .62);
                backdrop-filter: blur(3px);
                padding:12px;
            }
            .calendar-modal.open { display:flex; }
            .calendar-modal-card {
                width:min(460px, 100%);
                border:1px solid rgba(145,178,255,.38);
                border-radius:14px;
                background:rgba(4, 10, 26, .96);
                box-shadow:0 14px 32px rgba(0,0,0,.34);
                padding:14px;
                color:#dff3ff;
            }
            .calendar-modal-card h4 {
                margin:0 0 6px;
                font-size:18px;
                color:#e7f5ff;
            }
            .calendar-modal-card p {
                margin:0 0 10px;
                color:#a9c4ea;
                font-size:12px;
            }
            .calendar-modal-actions {
                display:flex;
                gap:8px;
                justify-content:flex-end;
                margin-top:6px;
            }
            .calendar-modal-actions button {
                width:auto;
                padding:9px 12px;
            }
            .flow-panel-enter { animation: flowSlide .22s ease-out; }
            @keyframes flowSlide {
                from { opacity:0; transform:translateX(16px); }
                to { opacity:1; transform:translateX(0); }
            }
            @keyframes nodeGlow {
                0% { box-shadow:0 0 0 rgba(82,214,255,0); }
                50% { box-shadow:0 0 14px rgba(82,214,255,.18); }
                100% { box-shadow:0 0 0 rgba(82,214,255,0); }
            }
            @keyframes astroPulse {
                0% { transform:scale(1); }
                50% { transform:scale(1.22); }
                100% { transform:scale(1); }
            }
            body.simple-mode .steps,
            body.simple-mode .helper,
            body.simple-mode .pill-row,
            body.simple-mode .advanced-field {
                display:none;
            }
            body.simple-mode .card { padding:14px; }
            @keyframes spinOrbit {
                from { transform:rotate(0deg); }
                to { transform:rotate(360deg); }
            }
            @keyframes driftStars {
                0% { transform:translateY(0px) translateX(0px); }
                50% { transform:translateY(-6px) translateX(4px); }
                100% { transform:translateY(0px) translateX(0px); }
            }
            @media (max-width: 760px) {
                .hero h1 { font-size:31px; }
                .hero h1 .brand-sub { font-size:12px; letter-spacing:.05em; }
                .wrap { padding: 0 12px 22px; }
                .hero .orbit,
                .hero .orbit.orbit-2 { display:none; }
                .calendar-shell { grid-template-columns:1fr; }
                .calendar-day { min-height:84px; }
                .calendar-day-actions { grid-template-columns:minmax(0, 1fr) 28px; gap:4px; }
                .calendar-time { font-size:9px; padding:3px 3px; }
                .calendar-plan-btn { width:28px; min-width:28px; }
            }
    </style>
  </head>
  <body>
    <div class="wrap">
                        <div class="constellation-bg" aria-hidden="true"></div>
            <div class="hero">
                <p class="brand-eyebrow">Automation Platform</p>
                <div class="brand-title">
                    <span class="brand-mark" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 3L14.7 9.3L21 12L14.7 14.7L12 21L9.3 14.7L3 12L9.3 9.3L12 3Z" stroke="#bfe7ff" stroke-width="1.4"/>
                            <circle cx="12" cy="12" r="1.9" fill="#8fe3ff"/>
                        </svg>
                    </span>
                    <h1><span class="brand-main">Meteoro</span><span class="brand-sub">by Comertex</span></h1>
                </div>
                <p>Interfaz guiada para enviar mensajes, subir imagenes y lanzar campanas desde Excel sin necesitar conocimientos tecnicos.</p>
                <div class="steps">
                    <span class="step">1. Elige marca</span>
                    <span class="step">2. Selecciona template o mensaje</span>
                    <span class="step">3. Carga Excel o envia prueba</span>
                    <span class="step">4. Revisa estado en tiempo real</span>
                </div>
                <span class="orbit" aria-hidden="true"></span>
                <span class="orbit orbit-2" aria-hidden="true"></span>
            </div>
            <div class="top-nav">
                <button id="navCampaignsBtn" type="button" class="active">Campanas</button>
                <button id="navDataBtn" type="button">Bases de datos</button>
                <button id="navCalendarBtn" type="button">Calendario</button>
                <button id="toggleAdvancedBtn" type="button" class="secondary secondary-toggle">Modo experto</button>
            </div>

            <div class="astro-bar">
                <div class="astro-pill"><span>Local</span><b id="astroLocal">--:--</b></div>
                <div class="astro-pill"><span>UTC</span><b id="astroUtc">--:--</b></div>
                <div class="astro-pill"><span>Fase lunar</span><b id="astroMoon">--</b></div>
                <div class="astro-pill"><span>Mision</span><b id="astroMission">Campanas · Paso 1</b></div>
            </div>

            <div class="flow-toolbar campaign-only" id="campaignFlowToolbar">
                <div class="flow-steps">
                    <button type="button" class="flow-chip active" data-go-step="0"><span class="astro-dot astro-meteor"></span>1. Marca</button>
                    <button type="button" class="flow-chip" data-go-step="1"><span class="astro-dot astro-sun"></span>2. Envio y templates</button>
                    <button type="button" class="flow-chip" data-go-step="2"><span class="astro-dot astro-moon"></span>3. Excel y campanas</button>
                    <button type="button" class="flow-chip" data-go-step="3"><span class="astro-dot astro-planet"></span>4. Interactivo</button>
                    <button type="button" class="flow-chip" data-go-step="4"><span class="astro-dot astro-star"></span>5. Logs</button>
                </div>
                <div class="flow-controls">
                    <button id="flowPrevBtn" type="button" class="secondary">Anterior</button>
                    <button id="flowNextBtn" type="button">Siguiente</button>
                </div>
                <span class="flow-swipe-hint">Desliza para cambiar de paso</span>
                <div class="flow-progress"><div id="flowProgressFill" class="flow-progress-fill"></div></div>
            </div>

            <div class="kpi-strip campaign-only" id="kpiStrip">
                <div class="kpi-card"><div class="kpi-label">Entregados hoy</div><div class="kpi-value" id="kpiSentToday">0</div></div>
                <div class="kpi-card"><div class="kpi-label">Fallidos hoy</div><div class="kpi-value" id="kpiFailedToday">0</div></div>
                <div class="kpi-card"><div class="kpi-label">Tasa de exito</div><div class="kpi-value" id="kpiSuccessRate">--</div></div>
                <div class="kpi-card"><div class="kpi-label">Campanas activas</div><div class="kpi-value" id="kpiActiveCampaigns">0</div></div>
            </div>

            <div class="card campaign-only" data-flow-step="0" style="margin-bottom:14px;padding:12px">
                <div class="row" style="align-items:flex-end">
                    <div style="min-width:220px;max-width:360px;flex:1">
                        <label>Marca / Environment</label>
                        <select id="brandSelect"></select>
                    </div>
                    <p id="brandInfo" class="muted" style="margin:0;flex:2">Selecciona la marca activa. Los IDs se muestran organizados para copiar rapido.</p>
                </div>
                <div class="brand-meta">
                    <div class="brand-id-card">
                        <label>Phone Number ID</label>
                        <div class="brand-id-row">
                            <div id="brandPhoneId" class="brand-id-value mono">-</div>
                            <button id="copyBrandPhoneId" type="button" class="secondary mini-copy">Copiar</button>
                        </div>
                    </div>
                    <div class="brand-id-card">
                        <label>WABA ID</label>
                        <div class="brand-id-row">
                            <div id="brandWabaId" class="brand-id-value mono">-</div>
                            <button id="copyBrandWabaId" type="button" class="secondary mini-copy">Copiar</button>
                        </div>
                    </div>
                    <div class="brand-id-card">
                        <label>Business ID</label>
                        <div class="brand-id-row">
                            <div id="brandBusinessId" class="brand-id-value mono">-</div>
                            <button id="copyBrandBusinessId" type="button" class="secondary mini-copy">Copiar</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="grid campaign-only send-template-grid" data-flow-step="1">
                <div style="grid-column:1/-1" class="pipeline-mini">
                    <span class="pipeline-node">1) Configura envio</span>
                    <span class="pipeline-node">2) Sube media si aplica</span>
                    <span class="pipeline-node">3) Selecciona y envia template</span>
                </div>
                <div class="card">
                    <h3>Envio individual</h3>
                    <p class="helper">Usa esta seccion para pruebas uno a uno antes de lanzar una campana.</p>
                    <div class="mb"><label>Tipo de envio</label><select id="singleType"><option value="text">text</option><option value="media">media</option><option value="template">template (manual)</option><option value="template-smart">template smart (validado)</option></select></div>
                    <div class="mb"><label>Numero destino</label><input id="singleTo" placeholder="57300..." /></div>
                    <div class="mb advanced-field"><label>Payload JSON</label><textarea id="singlePayload" class="mono"></textarea></div>
                    <button id="singleSendBtn">Enviar</button>
                    <p class="muted" style="font-size:11px;margin-top:6px">Mensajes text/media requieren sesion abierta de 24h. Para envios fuera de ventana usa template.</p>
                    <p id="singleResult" class="muted"></p>
                </div>

                <div class="card">
                    <h3>Media de soporte</h3>
                    <p class="helper">Al subir aqui obtienes un media_id listo para usar en templates con header multimedia.</p>
                    <div class="mb"><input id="mediaFile" type="file" /></div>
                    <button id="mediaUploadBtn" class="warn">Subir a Meta</button>
                    <div id="mediaIdBox" style="display:none;margin-top:8px">
                        <label style="font-size:11px">media_id obtenido:</label>
                        <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                            <input id="mediaIdDisplay" class="mono" readonly style="flex:1;background:#1e1e2e;color:#cdd6f4;font-size:12px" />
                            <button id="copyMediaIdBtn" class="secondary" style="width:auto;padding:6px 12px;font-size:12px">Copiar</button>
                            <button id="useMediaIdBtn" class="secondary" style="width:auto;padding:6px 12px;font-size:12px">Usar en envio</button>
                        </div>
                    </div>
                    <p id="mediaResult" class="muted"></p>
                </div>

                <div class="card">
                    <h3>Template studio</h3>
                    <p class="helper">Completa campos guiados y evita errores de estructura o idioma de la template.</p>
                    <div class="mb"><button id="refreshTemplatesBtn" class="secondary">Actualizar templates</button></div>
                    <div class="mb"><label>Template</label><select id="templateName"></select></div>
                    <div class="mb advanced-field"><label>Requisitos detectados</label><textarea id="templateRequirements" class="mono" readonly></textarea></div>
                    <div class="mb"><label>Constructor visual de parametros</label><div id="templateBuilderFields" class="muted">Selecciona una template...</div></div>
                    <div class="row mb"><button id="generateTemplateInputsBtn" class="secondary">Generar templateInputs desde formulario</button></div>
                    <div class="mb advanced-field"><label>templateInputs JSON</label><textarea id="templateInputs" class="mono"></textarea></div>
                    <div class="row">
                        <button id="applyTemplateToSingleBtn" class="secondary">Copiar a envio smart</button>
                        <button id="copyTemplateToCampaignBtn" class="secondary">Copiar a campana Excel</button>
                        <button id="sendTemplateNowBtn" style="width:auto;padding:10px 14px">Enviar template ahora</button>
                    </div>
                    <p id="templateSendResult" class="muted"></p>
                </div>
            </div>

            <div class="grid campaign-only" data-flow-step="2">
                <div class="card" id="campaignCard">
                    <h3>4) Campana desde Excel</h3>
                    <p class="helper">Sube el archivo con telefonos y crea el envio masivo en pocos pasos.</p>
                    <div class="mb"><input id="excelFile" type="file" accept=".xlsx,.xls,.csv" /></div>
                    <div class="mb"><label>Columna de telefono</label><input id="phoneColumn" value="telefono" /></div>
                    <div class="mb">
                        <label>Inicio programado</label>
                        <div class="schedule-box">
                            <div class="schedule-quick">
                                <button id="scheduleNowBtn" type="button" class="secondary">Enviar ahora</button>
                                <button id="scheduleIn30Btn" type="button" class="secondary">+30 min</button>
                                <button id="scheduleTonightBtn" type="button" class="secondary">Hoy 8:00 PM</button>
                                <button id="scheduleTomorrowBtn" type="button" class="secondary">Mañana 9:00 AM</button>
                            </div>
                            <div class="schedule-display">
                                <div id="startAtDisplay" class="tag">Sin programacion. Se enviara al crear la campana.</div>
                                <button id="scheduleOpenBtn" type="button" class="secondary" style="width:auto">Elegir fecha</button>
                            </div>
                            <div class="solar-scheduler" id="solarScheduler" aria-hidden="true">
                                <div class="solar-stage">
                                    <div class="solar-orbit solar-orbit-3"><div class="solar-arm" style="transform:rotate(120deg)"><span class="solar-planet"></span></div></div>
                                    <div class="solar-orbit solar-orbit-2"><div id="scheduleOrbitArm" class="solar-arm"><span id="scheduleOrbitPlanet" class="solar-planet accent"></span></div></div>
                                    <div class="solar-orbit solar-orbit-1"><div class="solar-arm" style="transform:rotate(250deg)"><span class="solar-planet"></span></div></div>
                                    <div class="solar-core"></div>
                                </div>
                                <div id="scheduleOrbitLabel" class="solar-label">Orbita en reposo: envio inmediato</div>
                            </div>
                            <div id="schedulePopover" class="schedule-popover hidden">
                                <div class="row mb">
                                    <div style="flex:1;min-width:180px"><label>Fecha</label><input id="scheduleDate" type="date" /></div>
                                    <div style="flex:1;min-width:140px"><label>Hora</label><input id="scheduleTime" type="time" value="09:00" /></div>
                                </div>
                                <div class="row">
                                    <button id="scheduleApplyBtn" type="button" style="width:auto">Aplicar</button>
                                    <button id="scheduleCloseBtn" type="button" class="secondary" style="width:auto">Cerrar</button>
                                </div>
                            </div>
                            <input id="startAtPicker" type="datetime-local" style="display:none" />
                            <input id="startAt" class="mono advanced-field" placeholder="ISO manual opcional (ej: 2026-04-01T13:00:00-05:00)" />
                            <p id="startAtPreview" class="muted" style="margin-top:8px">Se enviara inmediatamente al crear la campana.</p>
                            <p id="scheduleWindowStatus" class="schedule-window-status">Ventana de lanzamiento: inmediata</p>
                        </div>
                    </div>
                    <div class="mb advanced-field"><label>Mensaje (JSON)</label><textarea id="campaignMessage" class="mono"></textarea></div>
                    <div class="mb advanced-field"><label>Anti-spam (JSON)</label><textarea id="campaignAntiSpam" class="mono"></textarea></div>
                    <button id="campaignSendBtn">Crear campana</button>
                    <p id="campaignResult" class="muted"></p>
                </div>

                <div class="card">
                    <h3>5) Campanas</h3>
                    <p class="helper">Seguimiento en vivo de envios creados.</p>
                    <table id="campaignsTable">
                        <thead><tr><th>ID</th><th>Estado</th><th>Tipo</th><th>Total</th><th>Enviados</th><th>Fallidos</th></tr></thead>
                        <tbody><tr><td colspan="6" class="muted">Cargando...</td></tr></tbody>
                    </table>
                </div>
            </div>

            <div class="grid campaign-only" data-flow-step="3">
                <div class="card" style="grid-column:1/-1">
                    <h3>7) Mensaje Interactivo <span class="muted" style="font-size:12px;font-weight:normal">(requiere sesion activa de 24h con el usuario)</span></h3>
                    <p class="helper">Crea mensajes con botones o listas para conversaciones en curso.</p>
                    <div class="row mb">
                        <div style="flex:1;min-width:180px"><label>Numero destino</label><input id="interactiveTo" placeholder="57300..." /></div>
                        <div style="flex:0 0 220px"><label>Tipo interactivo</label><select id="interactiveType"><option value="button">button (botones rapidos)</option><option value="list">list (lista de opciones)</option></select></div>
                    </div>
                    <div id="interactiveBuilderFields"></div>
                    <div class="row mb" style="margin-top:10px">
                        <button id="interactiveSendBtn" style="width:auto;padding:10px 28px">Enviar interactivo</button>
                        <p id="interactiveResult" class="muted" style="margin:0;flex:1"></p>
                    </div>
                </div>
            </div>

            <div id="dataView" class="grid" style="display:none">
                <div class="card" style="grid-column:1/-1">
                    <h3>8) Modulo ShopifySQL (beta)</h3>
                    <p class="helper">Pestana independiente para construir bases de datos desde consultas SQL/Shopify/Google Sheets. Este modulo aun no ejecuta consultas ni se conecta con campanas.</p>
                    <div class="pill-row">
                        <span class="pill">SHOW/SELECT</span>
                        <span class="pill">FROM</span>
                        <span class="pill">WHERE</span>
                        <span class="pill">GROUP BY</span>
                        <span class="pill">HAVING</span>
                        <span class="pill">ORDER BY</span>
                        <span class="pill">LIMIT/OFFSET</span>
                        <span class="pill">Variables dinamicas</span>
                    </div>

                    <div class="row mb">
                        <div style="flex:1;min-width:220px"><label>Origen</label><select id="dataSource"><option value="shopify-crm">Shopify CRM</option><option value="sql">SQL Database</option><option value="google-sheets">Google Sheets</option></select></div>
                        <div style="flex:1;min-width:220px"><label>Modo de consulta</label><select id="queryMode"><option value="show">SHOW style</option><option value="select">SELECT style</option></select></div>
                    </div>

                    <div class="row mb">
                        <div style="flex:1;min-width:220px"><label>SHOW/SELECT (campos separados por coma)</label><input id="queryFields" placeholder="id, customer_name, phone, city, total_orders" /></div>
                        <div style="flex:1;min-width:220px"><label>FROM (tabla, vista o sheet)</label><input id="queryFrom" placeholder="customers" /></div>
                    </div>

                    <div class="mb advanced-field"><label>JOIN (opcional, una por linea)</label><textarea id="queryJoin" class="mono" placeholder="LEFT JOIN orders o ON o.customer_id = customers.id"></textarea></div>
                    <div class="mb"><label>WHERE (opcional)</label><textarea id="queryWhere" class="mono" placeholder="country = {{country}} AND total_orders >= {{min_orders}}"></textarea></div>
                    <div class="row mb advanced-field">
                        <div style="flex:1;min-width:220px"><label>GROUP BY (opcional)</label><input id="queryGroupBy" placeholder="country, city" /></div>
                        <div style="flex:1;min-width:220px"><label>HAVING (opcional)</label><input id="queryHaving" placeholder="COUNT(id) > {{min_customers}}" /></div>
                    </div>
                    <div class="row mb advanced-field">
                        <div style="flex:1;min-width:220px"><label>ORDER BY (opcional)</label><input id="queryOrderBy" placeholder="created_at DESC" /></div>
                        <div style="flex:1;min-width:120px"><label>LIMIT</label><input id="queryLimit" placeholder="500" /></div>
                        <div style="flex:1;min-width:120px"><label>OFFSET</label><input id="queryOffset" placeholder="0" /></div>
                    </div>

                    <div class="row mb advanced-field">
                        <div style="flex:1;min-width:220px"><label>Sintaxis de variable</label><select id="varSyntax"><option value="mustache">{{variable}}</option><option value="colon">:variable</option><option value="dollar">$variable</option></select></div>
                        <div style="flex:1;min-width:220px"><label>Nombre variable</label><input id="varName" placeholder="country" /></div>
                        <div style="flex:1;min-width:220px"><label>Valor por defecto</label><input id="varDefault" placeholder="CO" /></div>
                        <div style="flex:0 0 auto;align-self:flex-end"><button id="addVarBtn" class="secondary" style="width:auto;padding:11px 14px">Agregar variable</button></div>
                    </div>

                    <div class="mb advanced-field"><label>Variables (JSON)</label><textarea id="queryVariables" class="mono" placeholder='{"country":{"default":"CO","required":true,"type":"string"}}'></textarea></div>
                    <div class="row">
                        <button id="generateDataBlueprintBtn">Generar blueprint</button>
                        <button id="copyDataBlueprintBtn" class="secondary" style="width:auto;padding:10px 14px">Copiar JSON</button>
                        <button id="resetDataBlueprintBtn" class="secondary" style="width:auto;padding:10px 14px">Limpiar</button>
                    </div>
                    <div class="mb advanced-field" style="margin-top:10px"><label>SQL generado (preview)</label><textarea id="queryPreview" class="mono" readonly></textarea></div>
                    <div class="mb advanced-field"><label>Blueprint generado (JSON)</label><textarea id="dataBlueprintOutput" class="mono" readonly></textarea></div>
                    <p id="dataBuilderResult" class="muted mini"></p>
                </div>
            </div>

            <div id="calendarView" class="grid" style="display:none">
                <div class="card" style="grid-column:1/-1">
                    <h3>9) Programador mensual</h3>
                    <p class="helper">Vista estilo planner para organizar multiples campanas por mes y revisar huecos de envio.</p>
                    <div class="calendar-shell">
                        <div>
                            <div class="calendar-toolbar">
                                <div id="calendarMonthTitle" class="calendar-title">Mes</div>
                                <button id="calendarPrevMonthBtn" type="button" class="secondary" style="width:auto">Mes anterior</button>
                                <button id="calendarTodayBtn" type="button" class="secondary" style="width:auto">Hoy</button>
                                <button id="calendarNextMonthBtn" type="button" class="secondary" style="width:auto">Mes siguiente</button>
                            </div>
                            <div class="calendar-legend">
                                <span>scheduled: pendiente</span>
                                <span>running: en ejecucion</span>
                                <span>completed: finalizada</span>
                                <span>failed/error: revisar</span>
                            </div>
                            <div id="calendarGrid" class="calendar-grid"></div>
                        </div>
                        <aside class="calendar-side">
                            <h4 id="calendarSelectedTitle">Dia seleccionado</h4>
                            <p id="calendarSelectedHint" class="muted" style="margin:0">Selecciona una fecha para ver detalle y saltar al programador.</p>
                            <div class="row" style="margin:0;align-items:flex-end">
                                <div style="flex:1;min-width:140px">
                                    <label>Hora sugerida</label>
                                    <input id="calendarSelectedTime" type="time" value="09:00" />
                                </div>
                            </div>
                            <button id="calendarGoToSchedulerBtn" type="button" style="width:auto">Programar nueva campana en este dia</button>
                            <div id="calendarDayAgenda" class="calendar-agenda"></div>
                        </aside>
                    </div>
                </div>
            </div>

            <div id="calendarQuickModal" class="calendar-modal" aria-hidden="true">
                <div class="calendar-modal-card">
                    <h4>Programacion rapida</h4>
                    <p>Define la hora y una referencia de base. Luego pasamos directo al paso de creacion de campana.</p>
                    <div class="row mb" style="align-items:flex-end">
                        <div style="flex:1;min-width:170px">
                            <label>Fecha</label>
                            <input id="calendarQuickDate" type="date" readonly />
                        </div>
                        <div style="flex:1;min-width:130px">
                            <label>Hora</label>
                            <input id="calendarQuickTime" type="time" value="09:00" />
                        </div>
                    </div>
                    <div class="mb">
                        <label>Base / referencia</label>
                        <input id="calendarQuickBase" placeholder="Ej: clientes-vip-abril" />
                    </div>
                    <div class="calendar-modal-actions">
                        <button id="calendarQuickCloseBtn" type="button" class="secondary">Cerrar</button>
                        <button id="calendarQuickApplyBtn" type="button">Ir a programar</button>
                    </div>
                </div>
            </div>

            <div class="card section campaign-only" data-flow-step="4">
                <h3>6) Logs recientes</h3>
                <p class="helper">Historial de resultados para auditoria y soporte.</p>
                <table id="logsTable">
                    <thead><tr><th>Fecha</th><th>Campana</th><th>Telefono</th><th>Estado</th><th>Intento</th><th>Error</th></tr></thead>
                    <tbody><tr><td colspan="6" class="muted">Cargando...</td></tr></tbody>
                </table>
      </div>
    </div>
    <button id="openGuideBtn" type="button" class="astro-guide-fab">Oraculo</button>
    <div id="astroGuidePanel" class="astro-guide-panel hidden" role="dialog" aria-modal="false" aria-label="Guia de uso Meteoro">
        <div class="astro-guide-head">
            <span class="astro-mascot" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="9" stroke="#bce7ff" stroke-width="1.4"/>
                    <circle cx="9" cy="10" r="1" fill="#bce7ff"/>
                    <circle cx="15" cy="10" r="1" fill="#bce7ff"/>
                    <path d="M8.5 14.5C9.3 15.7 10.5 16.3 12 16.3C13.5 16.3 14.7 15.7 15.5 14.5" stroke="#bce7ff" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
            </span>
            <div>
                <h4>Oraculo de Meteoro</h4>
                <p>El avatar guia te cuenta el recorrido del sistema en tono narrativo.</p>
            </div>
        </div>
        <div id="astroGuideContext" class="astro-guide-context">En este instante, las estrellas apuntan al portal de Marca: elige COMERTEX o TRU y alinea tus IDs.</div>
        <ol class="astro-guide-list">
            <li><b>Marca:</b> aqui nace la ruta. Activa el entorno correcto antes de enviar.</li>
            <li><b>Envio + Templates:</b> prueba la nave en corto trayecto y confirma plantilla/media.</li>
            <li><b>Excel y campanas:</b> prepara la flota, define la hora y despega en lote.</li>
            <li><b>Interactivo:</b> abre conversacion con botones o listas cuando haya sesion activa.</li>
            <li><b>Logs:</b> consulta el cielo de eventos para detectar aciertos y errores.</li>
            <li><b>Bases de datos:</b> dibuja audiencias con consultas sin tocar las campanas activas.</li>
        </ol>
        <div class="astro-guide-actions">
            <button id="closeGuideBtn" type="button" class="secondary">Cerrar</button>
        </div>
    </div>
    <div id="toastWrap" class="toast-wrap" aria-live="polite"></div>
    <script>
            function stringify(obj) { return JSON.stringify(obj, null, 2); }
            function showToast(ok, text) {
                if (!text) { return; }
                var wrap = document.getElementById('toastWrap');
                if (!wrap) { return; }
                var low = String(text).toLowerCase();
                if (low.indexOf('enviando') >= 0 || low.indexOf('cargando') >= 0) {
                    return;
                }
                var el = document.createElement('div');
                el.className = 'toast ' + (ok ? 'ok' : 'err');
                el.textContent = text;
                wrap.appendChild(el);
                setTimeout(function(){
                    if (el && el.parentNode) { el.parentNode.removeChild(el); }
                }, 2600);
            }
            function setResult(elId, ok, text) {
                var el = document.getElementById(elId);
                el.className = ok ? 'ok' : 'err';
                el.textContent = text;
                showToast(ok, text);
            }
            function tryParseJson(text, fallback) {
                try { return JSON.parse(text); } catch (_e) { return fallback; }
            }

            function csvToList(text) {
                if (!text) { return []; }
                return text.split(',').map(function(v){ return v.trim(); }).filter(Boolean);
            }

            function getSelectedBrand() {
                var el = document.getElementById('brandSelect');
                if (!el || !el.value) { return 'marca1'; }
                return el.value;
            }

            function withBrandPath(path) {
                var sep = path.indexOf('?') >= 0 ? '&' : '?';
                return path + sep + 'brand=' + encodeURIComponent(getSelectedBrand());
            }

            function withBrandPayload(payload) {
                var body = payload || {};
                body.brand = getSelectedBrand();
                return body;
            }

            function getMoonPhaseLabel(dateObj) {
                var knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
                var synodicMonthMs = 29.53058867 * 24 * 60 * 60 * 1000;
                var phase = ((dateObj.getTime() - knownNewMoon) % synodicMonthMs + synodicMonthMs) % synodicMonthMs;
                var ratio = phase / synodicMonthMs;
                if (ratio < 0.03 || ratio > 0.97) return 'Nueva';
                if (ratio < 0.22) return 'Creciente';
                if (ratio < 0.28) return 'Cuarto creciente';
                if (ratio < 0.47) return 'Gibosa creciente';
                if (ratio < 0.53) return 'Llena';
                if (ratio < 0.72) return 'Gibosa menguante';
                if (ratio < 0.78) return 'Cuarto menguante';
                return 'Menguante';
            }

            function renderAstroTelemetry() {
                var now = new Date();
                var localEl = document.getElementById('astroLocal');
                var utcEl = document.getElementById('astroUtc');
                var moonEl = document.getElementById('astroMoon');
                var missionEl = document.getElementById('astroMission');
                if (localEl) { localEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
                if (utcEl) { utcEl.textContent = now.toUTCString().slice(17, 22); }
                if (moonEl) { moonEl.textContent = getMoonPhaseLabel(now); }
                if (missionEl) {
                    var isCampaigns = document.getElementById('navCampaignsBtn').classList.contains('active');
                    var isData = document.getElementById('navDataBtn').classList.contains('active');
                    if (isCampaigns) {
                        missionEl.textContent = 'Campanas · Paso ' + ((window._campaignStepIndex || 0) + 1);
                    } else if (isData) {
                        missionEl.textContent = 'Bases de datos · Exploracion';
                    } else {
                        missionEl.textContent = 'Calendario · Programador mensual';
                    }
                }
            }

            function renderAstroGuideContext() {
                var ctx = document.getElementById('astroGuideContext');
                if (!ctx) { return; }
                var isCampaigns = document.getElementById('navCampaignsBtn').classList.contains('active');
                var isCalendar = document.getElementById('navCalendarBtn').classList.contains('active');
                if (isCalendar) {
                    ctx.textContent = 'El calendario ordena tus lanzamientos del mes: toca un dia para ver campanas y abre el programador en segundos.';
                    return;
                }
                if (!isCampaigns) {
                    ctx.textContent = 'Las cartas celestes se abren en Bases de datos: aqui forjas audiencias con SHOW/SELECT, filtros y variables.';
                    return;
                }
                var step = window._campaignStepIndex || 0;
                var map = [
                    'Veo el primer signo: Marca. Elige COMERTEX o TRU y alinea Phone/WABA/Business ID para abrir el canal correcto.',
                    'La constelacion de Envio y Templates indica prueba corta: mensaje individual, media y plantilla bien validadas.',
                    'El oraculo del paso Excel y campanas sugiere cargar base, fijar columna telefono y marcar la ventana de lanzamiento.',
                    'En el cuarto cielo, Interactivo: activa botones o listas para guiar la conversacion viva del cliente.',
                    'Las estrellas finales muestran Logs: alli lees el destino de cada envio, exitos y errores incluidos.'
                ];
                ctx.textContent = map[step] || map[0];
            }

            function toggleAstroGuide(forceOpen) {
                var panel = document.getElementById('astroGuidePanel');
                if (!panel) { return; }
                var show = typeof forceOpen === 'boolean' ? forceOpen : panel.classList.contains('hidden');
                panel.classList.toggle('hidden', !show);
                if (show) {
                    renderAstroGuideContext();
                }
            }

            function setMainView(view) {
                var showCampaigns = view === 'campaigns';
                var showData = view === 'data';
                var showCalendar = view === 'calendar';
                document.querySelectorAll('.campaign-only').forEach(function(el) {
                    el.style.display = showCampaigns ? '' : 'none';
                });
                var dataView = document.getElementById('dataView');
                var calendarView = document.getElementById('calendarView');
                dataView.style.display = showData ? 'grid' : 'none';
                calendarView.style.display = showCalendar ? 'grid' : 'none';
                document.getElementById('navCampaignsBtn').classList.toggle('active', showCampaigns);
                document.getElementById('navDataBtn').classList.toggle('active', showData);
                document.getElementById('navCalendarBtn').classList.toggle('active', showCalendar);
                if (showCampaigns) {
                    setCampaignStep(window._campaignStepIndex || 0);
                }
                if (showCalendar) {
                    renderCalendarMonth();
                }
                renderAstroTelemetry();
                renderAstroGuideContext();
                try {
                    localStorage.setItem('meteoro.mainView', showCampaigns ? 'campaigns' : (showData ? 'data' : 'calendar'));
                } catch (_e) {}
            }

            function toYmd(dateObj) {
                var y = dateObj.getFullYear();
                var m = String(dateObj.getMonth() + 1).padStart(2, '0');
                var d = String(dateObj.getDate()).padStart(2, '0');
                return y + '-' + m + '-' + d;
            }

            function toLocalDateFromYmd(ymd) {
                var parts = String(ymd || '').split('-');
                if (parts.length !== 3) { return null; }
                var y = Number(parts[0]);
                var m = Number(parts[1]);
                var d = Number(parts[2]);
                if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) { return null; }
                return new Date(y, m - 1, d);
            }

            function formatMonthTitle(dateObj) {
                return dateObj.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
            }

            function ensureCalendarState() {
                if (!window._calendarCursor) {
                    var now = new Date();
                    window._calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
                }
                if (!window._calendarSelectedKey) {
                    window._calendarSelectedKey = toYmd(new Date());
                }
            }

            function campaignStatusClass(status) {
                return 'status-' + String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            }

            function renderCalendarAgenda(events, ymd) {
                var title = document.getElementById('calendarSelectedTitle');
                var hint = document.getElementById('calendarSelectedHint');
                var agenda = document.getElementById('calendarDayAgenda');
                if (!title || !hint || !agenda) { return; }

                var dateObj = toLocalDateFromYmd(ymd);
                title.textContent = dateObj ? dateObj.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Dia seleccionado';

                if (!events.length) {
                    hint.textContent = 'No hay campanas registradas para este dia. Puedes usar el boton para programar una nueva.';
                    agenda.innerHTML = '<div class="calendar-empty">Sin eventos para esta fecha.</div>';
                    return;
                }

                hint.textContent = events.length + ' campana(s) en esta fecha.';
                agenda.innerHTML = events.map(function(item) {
                    var t = item.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    var status = item.campaign.status || 'unknown';
                    return '<div class="calendar-event">'
                        + '<div class="calendar-event-head"><span class="calendar-event-time">' + t + '</span><span class="badge">' + status + '</span></div>'
                        + '<div class="calendar-event-meta">ID: ' + item.campaign.id + '</div>'
                        + '<div class="calendar-event-meta">Tipo: ' + (item.campaign.messageType || '-') + ' · Total: ' + (item.campaign.total || 0) + '</div>'
                        + '</div>';
                }).join('');
            }

            function openSchedulerForCalendarSlot(dayKey, hhmm, baseRef) {
                var dateObj = toLocalDateFromYmd(dayKey);
                if (!dateObj) {
                    setResult('campaignResult', false, 'Selecciona un dia valido en calendario.');
                    return;
                }
                var timeValue = (hhmm && /^\d{2}:\d{2}$/.test(hhmm)) ? hhmm : '09:00';
                setMainView('campaigns');
                setCampaignStep(2);
                var dateInput = document.getElementById('scheduleDate');
                var timeInput = document.getElementById('scheduleTime');
                var picker = document.getElementById('startAtPicker');
                if (dateInput) { dateInput.value = dayKey; }
                if (timeInput) { timeInput.value = timeValue; }
                if (picker) {
                    picker.value = dayKey + 'T' + timeValue;
                }
                updateStartAtPreview();
                toggleSchedulePopover(true);
                var extra = baseRef ? (' Referencia: ' + baseRef + '.') : '';
                setResult('campaignResult', true, 'Fecha y hora cargadas desde calendario.' + extra + ' Solo falta subir Excel y crear la campana.');
                document.getElementById('campaignCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            function toggleCalendarQuickModal(show, dayKey, hhmm) {
                var modal = document.getElementById('calendarQuickModal');
                var dateInput = document.getElementById('calendarQuickDate');
                var timeInput = document.getElementById('calendarQuickTime');
                var baseInput = document.getElementById('calendarQuickBase');
                if (!modal || !dateInput || !timeInput || !baseInput) { return; }
                if (show) {
                    var safeDay = dayKey || window._calendarSelectedKey || toYmd(new Date());
                    var safeTime = (hhmm && /^\d{2}:\d{2}$/.test(hhmm)) ? hhmm : '09:00';
                    window._calendarQuickDayKey = safeDay;
                    dateInput.value = safeDay;
                    timeInput.value = safeTime;
                    baseInput.value = '';
                }
                modal.classList.toggle('open', !!show);
                modal.setAttribute('aria-hidden', show ? 'false' : 'true');
            }

            function applyCalendarQuickModal() {
                var dayKey = window._calendarQuickDayKey || document.getElementById('calendarQuickDate').value;
                var hhmm = document.getElementById('calendarQuickTime').value || '09:00';
                var baseRef = (document.getElementById('calendarQuickBase').value || '').trim();
                window._calendarQuickBaseRef = baseRef;
                toggleCalendarQuickModal(false);
                window._campaignReferenceFromCalendar = baseRef;
                openSchedulerForCalendarSlot(dayKey, hhmm, baseRef);
            }

            function openCalendarQuickFromDay(dayKey) {
                var timeInput = document.querySelector('[data-day-time="' + dayKey + '"]');
                var hhmm = timeInput && timeInput.value ? timeInput.value : '09:00';
                toggleCalendarQuickModal(true, dayKey, hhmm);
            }

            function renderCalendarMonth() {
                ensureCalendarState();
                var title = document.getElementById('calendarMonthTitle');
                var grid = document.getElementById('calendarGrid');
                if (!title || !grid) { return; }

                var cursor = window._calendarCursor;
                var year = cursor.getFullYear();
                var month = cursor.getMonth();
                title.textContent = formatMonthTitle(cursor);

                var campaigns = Array.isArray(window._kpiCampaigns) ? window._kpiCampaigns : [];
                var grouped = {};
                campaigns.forEach(function(campaign) {
                    if (!campaign || !campaign.startAt) { return; }
                    var d = new Date(campaign.startAt);
                    if (Number.isNaN(d.getTime())) { return; }
                    var key = toYmd(d);
                    if (!grouped[key]) { grouped[key] = []; }
                    grouped[key].push({ campaign: campaign, date: d });
                });

                Object.keys(grouped).forEach(function(key) {
                    grouped[key].sort(function(a, b) { return a.date.getTime() - b.date.getTime(); });
                });

                var first = new Date(year, month, 1);
                var firstWeekDay = (first.getDay() + 6) % 7;
                var gridStart = new Date(year, month, 1 - firstWeekDay);
                var todayKey = toYmd(new Date());
                var selectedKey = window._calendarSelectedKey;
                var days = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];
                var html = days.map(function(label) { return '<div class="calendar-weekday">' + label + '</div>'; }).join('');

                for (var i = 0; i < 42; i += 1) {
                    var day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
                    var key = toYmd(day);
                    var events = grouped[key] || [];
                    var inMonth = day.getMonth() === month;
                    var classes = ['calendar-day'];
                    if (!inMonth) { classes.push('muted'); }
                    if (key === todayKey) { classes.push('today'); }
                    if (key === selectedKey) { classes.push('active'); }
                    var mini = events.slice(0, 2).map(function(item) {
                        var time = item.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        return '<div class="calendar-mini ' + campaignStatusClass(item.campaign.status) + '">' + time + ' · ' + (item.campaign.messageType || '-') + '</div>';
                    }).join('');
                    if (events.length > 2) {
                        mini += '<div class="calendar-mini">+' + (events.length - 2) + ' mas...</div>';
                    }
                    var baseHint = events[0] && events[0].campaign.baseReference ? ' (' + events[0].campaign.baseReference.slice(0, 12) + ')' : '';
                    mini += '<div class="calendar-day-actions" title="' + (baseHint ? baseHint : 'Click para programar') + '">'
                        + '<input type="time" class="calendar-time" value="09:00" data-day-time="' + key + '" />'
                        + '<button type="button" class="secondary calendar-plan-btn" data-day-plan="' + key + '" onclick="openCalendarQuickFromDay(this.dataset.dayPlan)">+</button>'
                        + '</div>';
                    html += '<div class="' + classes.join(' ') + '" data-day-key="' + key + '">'
                        + '<div class="calendar-day-head"><b>' + day.getDate() + '</b><span class="calendar-count">' + events.length + '</span></div>'
                        + '<div class="calendar-items">' + mini + '</div>'
                        + '</div>';
                }

                grid.innerHTML = html;
                renderCalendarAgenda(grouped[selectedKey] || [], selectedKey);
            }

            function moveCalendarMonth(delta) {
                ensureCalendarState();
                window._calendarCursor = new Date(window._calendarCursor.getFullYear(), window._calendarCursor.getMonth() + delta, 1);
                renderCalendarMonth();
            }

            function jumpCalendarToday() {
                var now = new Date();
                window._calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
                window._calendarSelectedKey = toYmd(now);
                renderCalendarMonth();
            }

            function openSchedulerForCalendarDay() {
                var selectedKey = window._calendarSelectedKey;
                var selectedTime = document.getElementById('calendarSelectedTime');
                var hhmm = selectedTime && selectedTime.value ? selectedTime.value : '09:00';
                openSchedulerForCalendarSlot(selectedKey, hhmm);
            }

            function setCampaignStep(index) {
                var panels = Array.prototype.slice.call(document.querySelectorAll('[data-flow-step]'));
                if (!panels.length) { return; }
                var next = Math.max(0, Math.min(index, panels.length - 1));
                window._campaignStepIndex = next;
                panels.forEach(function(panel, i) {
                    panel.style.display = i === next ? '' : 'none';
                    panel.classList.remove('flow-panel-enter');
                });
                if (panels[next]) {
                    panels[next].classList.add('flow-panel-enter');
                }
                document.querySelectorAll('.flow-chip').forEach(function(chip) {
                    var i = Number(chip.getAttribute('data-go-step'));
                    chip.classList.toggle('active', i === next);
                });
                var prevBtn = document.getElementById('flowPrevBtn');
                var nextBtn = document.getElementById('flowNextBtn');
                if (prevBtn) { prevBtn.disabled = next === 0; }
                if (nextBtn) {
                    nextBtn.disabled = next === panels.length - 1;
                    nextBtn.textContent = next === panels.length - 1 ? 'Ultimo paso' : 'Siguiente';
                }
                var progress = document.getElementById('flowProgressFill');
                if (progress) {
                    var pct = Math.round(((next + 1) / panels.length) * 100);
                    progress.style.width = pct + '%';
                }
                renderAstroTelemetry();
                renderAstroGuideContext();
                try {
                    localStorage.setItem('meteoro.campaignStep', String(next));
                } catch (_e) {}
            }

            function setupFlowSwipe() {
                var panels = Array.prototype.slice.call(document.querySelectorAll('[data-flow-step]'));
                if (!panels.length) { return; }
                var touchStartX = 0;
                var touchStartY = 0;
                var allowSwipe = false;

                function isCampaignViewActive() {
                    var btn = document.getElementById('navCampaignsBtn');
                    return !!(btn && btn.classList.contains('active'));
                }

                function isInteractiveTarget(target) {
                    return !!(target && target.closest('input, textarea, select, button, a, [contenteditable="true"]'));
                }

                panels.forEach(function(panel) {
                    panel.addEventListener('touchstart', function(ev) {
                        if (!isCampaignViewActive()) { return; }
                        if (!ev.touches || !ev.touches[0]) { return; }
                        if (isInteractiveTarget(ev.target)) {
                            allowSwipe = false;
                            return;
                        }
                        touchStartX = ev.touches[0].clientX;
                        touchStartY = ev.touches[0].clientY;
                        allowSwipe = true;
                    }, { passive: true });

                    panel.addEventListener('touchend', function(ev) {
                        if (!allowSwipe) { return; }
                        allowSwipe = false;
                        if (!isCampaignViewActive()) { return; }
                        if (!ev.changedTouches || !ev.changedTouches[0]) { return; }
                        var dx = ev.changedTouches[0].clientX - touchStartX;
                        var dy = ev.changedTouches[0].clientY - touchStartY;
                        if (Math.abs(dx) < 60) { return; }
                        if (Math.abs(dx) < Math.abs(dy) * 1.2) { return; }
                        if (dx < 0) {
                            setCampaignStep((window._campaignStepIndex || 0) + 1);
                        } else {
                            setCampaignStep((window._campaignStepIndex || 0) - 1);
                        }
                    }, { passive: true });
                });
            }

            function setAdvancedMode(enabled) {
                var isAdvanced = !!enabled;
                document.body.classList.toggle('simple-mode', !isAdvanced);
                var btn = document.getElementById('toggleAdvancedBtn');
                if (btn) {
                    btn.textContent = isAdvanced ? 'Modo quick' : 'Modo experto';
                }
                try {
                    localStorage.setItem('meteoro.advanced', isAdvanced ? '1' : '0');
                } catch (_e) {}
            }

            function writeTextToClipboard(text, successMsgElId) {
                if (!text) { return; }
                navigator.clipboard.writeText(String(text)).then(function() {
                    if (successMsgElId) {
                        setResult(successMsgElId, true, 'Copiado: ' + text);
                    }
                });
            }

            function renderBrandMeta(meta) {
                document.getElementById('brandPhoneId').textContent = meta.phoneNumberId || '-';
                document.getElementById('brandWabaId').textContent = meta.businessAccountId || '-';
                document.getElementById('brandBusinessId').textContent = meta.businessId || '-';
            }

            function toDatetimeLocalValue(dateObj) {
                var d = new Date(dateObj.getTime() - (dateObj.getTimezoneOffset() * 60000));
                return d.toISOString().slice(0, 16);
            }

            function syncScheduleInputsFromPicker() {
                var pickerVal = document.getElementById('startAtPicker').value.trim();
                var dateEl = document.getElementById('scheduleDate');
                var timeEl = document.getElementById('scheduleTime');
                if (!pickerVal) {
                    dateEl.value = '';
                    return;
                }
                var parts = pickerVal.split('T');
                dateEl.value = parts[0] || '';
                timeEl.value = (parts[1] || '').slice(0, 5) || '09:00';
            }

            function toggleSchedulePopover(show) {
                var pop = document.getElementById('schedulePopover');
                if (!pop) { return; }
                pop.classList.toggle('hidden', !show);
                if (show) {
                    syncScheduleInputsFromPicker();
                }
            }

            function applyScheduleFromPopover() {
                var dateVal = document.getElementById('scheduleDate').value.trim();
                var timeVal = document.getElementById('scheduleTime').value.trim() || '09:00';
                if (!dateVal) {
                    setResult('campaignResult', false, 'Selecciona una fecha para programar.');
                    return;
                }
                document.getElementById('startAtPicker').value = dateVal + 'T' + timeVal;
                document.getElementById('startAt').value = '';
                updateStartAtPreview();
                toggleSchedulePopover(false);
            }

            function setSchedulePreset(type) {
                var picker = document.getElementById('startAtPicker');
                var raw = document.getElementById('startAt');
                if (type === 'now') {
                    picker.value = '';
                    raw.value = '';
                    updateStartAtPreview();
                    toggleSchedulePopover(false);
                    return;
                }

                var when = new Date();
                if (type === 'in30') {
                    when = new Date(Date.now() + 30 * 60000);
                }
                if (type === 'today20') {
                    when.setHours(20, 0, 0, 0);
                    if (when.getTime() < Date.now()) {
                        when = new Date(Date.now() + 24 * 60 * 60 * 1000);
                        when.setHours(20, 0, 0, 0);
                    }
                }
                if (type === 'tomorrow9') {
                    when = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    when.setHours(9, 0, 0, 0);
                }
                picker.value = toDatetimeLocalValue(when);
                raw.value = '';
                updateStartAtPreview();
                toggleSchedulePopover(false);
            }

            function getCampaignStartAtIso() {
                var raw = document.getElementById('startAt').value.trim();
                if (raw) { return raw; }
                var pickerVal = document.getElementById('startAtPicker').value.trim();
                if (!pickerVal) { return ''; }
                var d = new Date(pickerVal);
                if (Number.isNaN(d.getTime())) { return ''; }
                return d.toISOString();
            }

            function updateStartAtPreview() {
                var preview = document.getElementById('startAtPreview');
                var display = document.getElementById('startAtDisplay');
                var orbitArm = document.getElementById('scheduleOrbitArm');
                var orbitLabel = document.getElementById('scheduleOrbitLabel');
                var windowStatus = document.getElementById('scheduleWindowStatus');
                var iso = getCampaignStartAtIso();
                if (!iso) {
                    preview.textContent = 'Se enviara inmediatamente al crear la campana.';
                    if (display) { display.textContent = 'Sin programacion. Se enviara al crear la campana.'; }
                    if (orbitArm) { orbitArm.style.transform = 'rotate(0deg)'; }
                    if (orbitLabel) { orbitLabel.textContent = 'Orbita en reposo: envio inmediato'; }
                    if (windowStatus) { windowStatus.textContent = 'Ventana de lanzamiento: inmediata'; }
                    return;
                }
                var d = new Date(iso);
                if (Number.isNaN(d.getTime())) {
                    preview.textContent = 'Fecha invalida. Ajusta el programador o el campo ISO.';
                    if (display) { display.textContent = 'Fecha invalida'; }
                    if (orbitLabel) { orbitLabel.textContent = 'Orbita inestable: revisa fecha y hora'; }
                    if (windowStatus) { windowStatus.textContent = 'Ventana de lanzamiento: invalida'; }
                    return;
                }
                preview.textContent = 'Programada para: ' + d.toLocaleString();
                if (display) { display.textContent = d.toLocaleString(); }
                var hourFraction = d.getHours() + (d.getMinutes() / 60);
                var angle = Math.round((hourFraction / 24) * 360);
                if (orbitArm) { orbitArm.style.transform = 'rotate(' + angle + 'deg)'; }
                if (orbitLabel) {
                    var dayName = d.toLocaleDateString(undefined, { weekday: 'short' });
                    orbitLabel.textContent = 'Orbita activa: ' + dayName + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
                if (windowStatus) {
                    var delta = d.getTime() - Date.now();
                    if (delta < 0) {
                        windowStatus.textContent = 'Ventana de lanzamiento: vencida';
                    } else if (delta <= 60 * 60 * 1000) {
                        windowStatus.textContent = 'Ventana de lanzamiento: cercana (<1h)';
                    } else if (delta <= 24 * 60 * 60 * 1000) {
                        windowStatus.textContent = 'Ventana de lanzamiento: dentro de hoy';
                    } else {
                        windowStatus.textContent = 'Ventana de lanzamiento: planificada a futuro';
                    }
                }
            }

            function renderKpis() {
                var campaigns = window._kpiCampaigns || [];
                var logs = window._kpiLogs || [];
                var today = new Date().toISOString().slice(0, 10);
                var sentToday = 0;
                var failedToday = 0;
                logs.forEach(function(l) {
                    var ts = String(l.timestamp || '');
                    var day = ts.slice(0, 10);
                    if (day !== today) { return; }
                    var st = String(l.status || '').toLowerCase();
                    if (st === 'sent' || st === 'success') { sentToday += 1; }
                    if (st === 'failed' || st === 'error') { failedToday += 1; }
                });
                var totalToday = sentToday + failedToday;
                var successRate = totalToday > 0 ? Math.round((sentToday * 100) / totalToday) + '%' : '--';
                var activeCampaigns = campaigns.filter(function(c) {
                    return c.status === 'running' || c.status === 'scheduled';
                }).length;

                document.getElementById('kpiSentToday').textContent = String(sentToday);
                document.getElementById('kpiFailedToday').textContent = String(failedToday);
                document.getElementById('kpiSuccessRate').textContent = successRate;
                document.getElementById('kpiActiveCampaigns').textContent = String(activeCampaigns);
            }

            async function loadBrands() {
                var select = document.getElementById('brandSelect');
                var info = document.getElementById('brandInfo');
                try {
                    var res = await fetch('/brands');
                    var json = await res.json();
                    var brands = (json.data || []);
                    if (!brands.length) {
                        select.innerHTML = '<option value="marca1">COMERTEX</option>';
                        info.textContent = 'No se detectaron marcas en .env. Usando configuracion por defecto.';
                        return;
                    }
                    select.innerHTML = brands.map(function(b){ return '<option value="' + b.key + '">' + (b.label || b.key) + '</option>'; }).join('');
                    var active = brands[0];
                    info.textContent = 'Activa: ' + (active.label || active.key) + ' | phoneNumberId: ' + (active.phoneNumberId || '-') + ' | waba: ' + (active.businessAccountId || '-');
                    renderBrandMeta(active);
                    select.addEventListener('change', function() {
                        var selected = brands.find(function(b){ return b.key === select.value; }) || brands[0];
                        info.textContent = 'Activa: ' + (selected.label || selected.key) + ' | phoneNumberId: ' + (selected.phoneNumberId || '-') + ' | waba: ' + (selected.businessAccountId || '-');
                        renderBrandMeta(selected);
                        window._lastUploadedMedia = null;
                        document.getElementById('mediaIdDisplay').value = '';
                        document.getElementById('mediaIdBox').style.display = 'none';
                        setResult('mediaResult', true, 'Marca cambiada. Si vas a usar header media, vuelve a subir el archivo en esta marca.');
                        refreshTemplates();
                    });
                } catch (_e) {
                    select.innerHTML = '<option value="marca1">COMERTEX</option>';
                    info.textContent = 'No fue posible cargar marcas. Usando configuracion por defecto.';
                    renderBrandMeta({ phoneNumberId: '-', businessAccountId: '-', businessId: '-' });
                }
            }

            var defaultSinglePayloads = {
                text: { text: 'Hola, este es un envio de prueba' },
                media: { mediaType: 'image', link: 'https://picsum.photos/800/400', caption: 'Prueba media' },
                template: { templateName: '', languageCode: 'es', components: [] },
                'template-smart': { templateName: '', languageCode: 'es', templateInputs: { body: [] } }
            };

            function syncSinglePayloadByType() {
                var type = document.getElementById('singleType').value;
                document.getElementById('singlePayload').value = stringify(defaultSinglePayloads[type]);
            }

            function renderTemplateBuilderFields(requirements) {
                var container = document.getElementById('templateBuilderFields');
                var html = '';

                if (requirements.header) {
                    html += '<div class="builder-group"><h4>HEADER (' + requirements.header.format + ')</h4>';
                    if (requirements.header.format === 'text') {
                        html += '<input data-builder="header-text" placeholder="Texto de header" />';
                    }
                    if (['image','video','document'].indexOf(requirements.header.format) >= 0) {
                        html += '<input data-builder="header-media-id" placeholder="media_id para header" />';
                        html += '<input data-builder="header-link" placeholder="o link publico https://..." />';
                    }
                    html += '</div>';
                }

                if (requirements.bodyPlaceholderCount > 0) {
                    html += '<div class="builder-group"><h4>BODY (' + requirements.bodyPlaceholderCount + ' parametros)</h4>';
                    for (var i = 0; i < requirements.bodyPlaceholderCount; i += 1) {
                        html += '<input data-builder="body-' + i + '" placeholder="Valor body #' + (i + 1) + '" />';
                    }
                    html += '</div>';
                }

                if (Array.isArray(requirements.buttons) && requirements.buttons.length > 0) {
                    var dyn = requirements.buttons.filter(function(b){ return b.requiresDynamicText; });
                    if (dyn.length > 0) {
                        html += '<div class="builder-group"><h4>BUTTONS dinamicos</h4>';
                        dyn.forEach(function(b) {
                            html += '<input data-builder="btn-' + b.index + '" placeholder="Valor dinamico para boton index ' + b.index + '" />';
                        });
                        html += '</div>';
                    }
                }

                container.innerHTML = html || '<span class="muted">Esta template no requiere parametros dinamicos.</span>';
            }

            function collectTemplateInputsFromBuilder(requirements) {
                var result = { body: [] };

                if (requirements.header) {
                    if (requirements.header.format === 'text') {
                        var hText = document.querySelector('[data-builder="header-text"]');
                        var headerText = hText ? hText.value.trim() : '';
                        if (headerText) {
                            result.header = { type: 'text', text: headerText };
                        }
                    }
                    if (['image','video','document'].indexOf(requirements.header.format) >= 0) {
                        var hId = document.querySelector('[data-builder="header-media-id"]');
                        var hLink = document.querySelector('[data-builder="header-link"]');
                        result.header = { type: requirements.header.format };
                        if (hId && hId.value.trim()) { result.header.mediaId = hId.value.trim(); }
                        if (hLink && hLink.value.trim()) { result.header.link = hLink.value.trim(); }
                    }
                }

                for (var i = 0; i < (requirements.bodyPlaceholderCount || 0); i += 1) {
                    var bodyInput = document.querySelector('[data-builder="body-' + i + '"]');
                    result.body.push(bodyInput ? bodyInput.value : '');
                }

                var dynamicButtons = (requirements.buttons || []).filter(function(b){ return b.requiresDynamicText; });
                if (dynamicButtons.length > 0) {
                    result.buttons = dynamicButtons.map(function(b) {
                        var input = document.querySelector('[data-builder="btn-' + b.index + '"]');
                        return { index: b.index, subType: 'url', text: input ? input.value : '' };
                    });
                }

                return result;
            }

      async function loadCampaigns() {
        const res = await fetch('/campaigns');
        const json = await res.json();
                var campaigns = (json.data || []);
                window._kpiCampaigns = campaigns;
                const rows = campaigns.map(function(c) { var baseCol = c.baseReference ? '<span class="muted" title="' + c.baseReference + '"> · ' + c.baseReference.slice(0, 18) + '</span>' : ''; return '<tr><td>' + c.id + '</td><td><span class="badge">' + c.status + '</span></td><td>' + c.messageType + baseCol + '</td><td>' + c.total + '</td><td>' + c.sent + '</td><td>' + c.failed + '</td></tr>'; }).join('');
                document.querySelector('#campaignsTable tbody').innerHTML = rows || '<tr><td colspan="6"><div class="empty-state">Aun no hay campanas. Sube un Excel en el paso 3 para crear la primera.</div></td></tr>';
                                renderCalendarMonth();
                renderKpis();
      }
      async function loadLogs() {
        const res = await fetch('/logs?limit=40');
        const json = await res.json();
                var logs = (json.data || []).slice().reverse();
                window._kpiLogs = logs;
                const rows = logs.map(function(l) { return '<tr><td>' + l.timestamp + '</td><td>' + (l.campaignId || '-') + '</td><td>' + (l.to || '-') + '</td><td>' + (l.status || '-') + '</td><td>' + (l.attempt || '-') + '</td><td>' + (l.error || '-') + '</td></tr>'; }).join('');
                document.querySelector('#logsTable tbody').innerHTML = rows || '<tr><td colspan="6"><div class="empty-state">No hay actividad reciente. Cuando envies mensajes veras el historial aqui.</div></td></tr>';
                renderKpis();
      }

            async function refreshTemplates() {
                const res = await fetch(withBrandPath('/templates'));
                const json = await res.json();
                var templates = (json.data && json.data.data) ? json.data.data : [];
                var select = document.getElementById('templateName');
                select.innerHTML = templates.map(function(t){ return '<option value="' + t.name + '" data-language="' + (t.language || '') + '">' + t.name + ' (' + t.status + ' · ' + (t.language || '-') + ')</option>'; }).join('');

                if (templates.length > 0) {
                    await loadTemplateRequirements(templates[0].name);
                } else {
                    select.innerHTML = '<option value="">Sin templates en esta marca</option>';
                    document.getElementById('templateBuilderFields').innerHTML = '<span class="muted">No hay templates disponibles para la marca seleccionada.</span>';
                }
            }

            async function loadTemplateRequirements(name) {
                if (!name) { return; }
                const res = await fetch(withBrandPath('/templates/' + encodeURIComponent(name) + '/requirements'));
                const json = await res.json();
                if (!json.ok) {
                    document.getElementById('templateRequirements').value = stringify(json);
                    return;
                }

                document.getElementById('templateRequirements').value = stringify(json.data);
                renderTemplateBuilderFields(json.data);
                var example = { body: [] };
                if (json.data.bodyPlaceholderCount > 0) {
                    for (var i = 0; i < json.data.bodyPlaceholderCount; i += 1) {
                        example.body.push('valor_' + (i + 1));
                    }
                }
                if (json.data.header) {
                    if (json.data.header.format === 'text') {
                        example.header = { type: 'text', text: 'header ejemplo' };
                    }
                    if (['image','video','document'].indexOf(json.data.header.format) >= 0) {
                        example.header = { type: json.data.header.format, mediaId: 'PEGA_MEDIA_ID' };
                    }
                }
                if (Array.isArray(json.data.buttons) && json.data.buttons.length > 0) {
                    example.buttons = json.data.buttons.filter(function(b){ return b.requiresDynamicText; }).map(function(b){ return { index: b.index, subType: 'url', text: 'valor_dinamico' }; });
                }
                document.getElementById('templateInputs').value = stringify(example);
            }

            async function sendSingle() {
                var to = document.getElementById('singleTo').value.trim();
                var type = document.getElementById('singleType').value;
                var payload = tryParseJson(document.getElementById('singlePayload').value, null);
                if (!to) { setResult('singleResult', false, 'Ingresa el numero destino.'); return; }
                if (!payload) { setResult('singleResult', false, 'El campo Payload tiene JSON invalido. Revisa la sintaxis.'); return; }

                var endpoint = '/send-text';
                if (type === 'media') { endpoint = '/send-media'; }
                if (type === 'template') { endpoint = '/send-template'; }
                if (type === 'template-smart') { endpoint = '/send-template-smart'; }

                payload.to = to;
                setResult('singleResult', true, 'Enviando...');
                try {
                    var res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(withBrandPayload(payload))
                    });
                    var json = await res.json();
                    if (json.ok) {
                        var msgId = json.data && json.data.messages && json.data.messages[0] ? json.data.messages[0].id : '';
                        setResult('singleResult', true, 'Enviado OK' + (msgId ? ' — id: ' + msgId : ''));
                    } else {
                        var errMsg = json.message || (json.errors ? json.errors.join(', ') : JSON.stringify(json).slice(0, 300));
                        setResult('singleResult', false, 'Error: ' + errMsg);
                    }
                } catch (e) {
                    setResult('singleResult', false, 'Error de red: ' + e.message);
                }
            }

            async function uploadMediaFile() {
                var input = document.getElementById('mediaFile');
                if (!input.files || !input.files[0]) {
                    setResult('mediaResult', false, 'Selecciona un archivo.');
                    return;
                }

                var form = new FormData();
                form.append('file', input.files[0]);
                form.append('brand', getSelectedBrand());

                const res = await fetch('/media/upload', { method: 'POST', body: form });
                const json = await res.json();
                if (json.ok) {
                    var mid = json.mediaId;
                    var mtype = json.mimeType || '';
                    document.getElementById('mediaIdDisplay').value = mid;
                    document.getElementById('mediaIdBox').style.display = 'block';
                    // Derive mediaType from MIME
                    var mediaTypeKey = 'image';
                    if (mtype.startsWith('video/')) mediaTypeKey = 'video';
                    else if (mtype.startsWith('audio/')) mediaTypeKey = 'audio';
                    else if (mtype === 'image/webp') mediaTypeKey = 'sticker';
                    else if (!mtype.startsWith('image/')) mediaTypeKey = 'document';
                    window._lastUploadedMedia = { mediaId: mid, mediaType: mediaTypeKey, mimeType: mtype, brand: getSelectedBrand() };
                    setResult('mediaResult', true, 'Subido OK — marca: ' + getSelectedBrand() + ' — tipo: ' + mtype + ' — id: ' + mid);
                } else {
                    setResult('mediaResult', false, 'Error: ' + (json.message || JSON.stringify(json)));
                }
            }

            async function createCampaign() {
                var excel = document.getElementById('excelFile');
                var message = tryParseJson(document.getElementById('campaignMessage').value, null);
                var antiSpam = tryParseJson(document.getElementById('campaignAntiSpam').value, null);
                if (!excel.files || !excel.files[0]) {
                    setResult('campaignResult', false, 'Selecciona archivo Excel.');
                    return;
                }
                if (!message || !antiSpam) {
                    setResult('campaignResult', false, 'JSON invalido en mensaje o anti-spam.');
                    return;
                }

                var form = new FormData();
                form.append('file', excel.files[0]);
                form.append('brand', getSelectedBrand());
                form.append('phoneColumn', document.getElementById('phoneColumn').value.trim());
                var startAt = getCampaignStartAtIso();
                if (startAt) { form.append('startAt', startAt); }
                form.append('message', JSON.stringify(message));
                form.append('antiSpam', JSON.stringify(antiSpam));
                var baseRef = window._calendarQuickBaseRef ? String(window._calendarQuickBaseRef).trim() : '';
                if (baseRef) { form.append('baseReference', baseRef); }

                const res = await fetch('/campaigns/from-excel', { method: 'POST', body: form });
                const json = await res.json();
                setResult('campaignResult', !!json.ok, json.ok ? ('Campana creada: ' + json.campaign.id) : ('Error: ' + (json.message || JSON.stringify(json))));
                await loadCampaigns();
            }

            function generateTemplateInputs() {
                var requirements = tryParseJson(document.getElementById('templateRequirements').value, null);
                if (!requirements || !requirements.templateName) {
                    setResult('singleResult', false, 'Primero selecciona una template valida.');
                    return;
                }
                var built = collectTemplateInputsFromBuilder(requirements);
                document.getElementById('templateInputs').value = stringify(built);
            }

            function copyTemplateToCampaign() {
                var templateName = document.getElementById('templateName').value;
                var inputs = tryParseJson(document.getElementById('templateInputs').value, { body: [] });
                var req = tryParseJson(document.getElementById('templateRequirements').value, null);
                var lang = (req && req.language) ? req.language : 'es';
                if (!templateName) {
                    alert('Selecciona una template antes de copiar.');
                    return;
                }
                document.getElementById('campaignMessage').value = stringify({ type: 'template', templateName: templateName, languageCode: lang, templateInputs: inputs });
                document.getElementById('campaignCard').scrollIntoView({ behavior: 'smooth' });
            }

            function copyTemplateToSingle() {
                var templateName = document.getElementById('templateName').value;
                var inputs = tryParseJson(document.getElementById('templateInputs').value, { body: [] });
                var req = tryParseJson(document.getElementById('templateRequirements').value, null);
                var lang = (req && req.language) ? req.language : 'es';
                document.getElementById('singleType').value = 'template-smart';
                document.getElementById('singlePayload').value = stringify({ templateName: templateName, languageCode: lang, templateInputs: inputs });
            }

            async function sendTemplateNow() {
                var to = document.getElementById('singleTo').value.trim();
                var templateName = document.getElementById('templateName').value;
                var inputs = tryParseJson(document.getElementById('templateInputs').value, null);
                var req = tryParseJson(document.getElementById('templateRequirements').value, null);
                var lang = (req && req.language) ? req.language : 'es';

                if (!to) {
                    setResult('templateSendResult', false, 'Ingresa el numero destino en Card 1.');
                    return;
                }
                if (!templateName) {
                    setResult('templateSendResult', false, 'Selecciona una template.');
                    return;
                }
                if (!inputs || typeof inputs !== 'object') {
                    setResult('templateSendResult', false, 'templateInputs JSON invalido.');
                    return;
                }

                setResult('templateSendResult', true, 'Enviando template...');
                try {
                    var res = await fetch('/send-template-smart', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(withBrandPayload({
                            to: to,
                            templateName: templateName,
                            languageCode: lang,
                            templateInputs: inputs
                        }))
                    });
                    var json = await res.json();
                    if (json.ok) {
                        var msgId = json.data && json.data.messages && json.data.messages[0] ? json.data.messages[0].id : '';
                        setResult('templateSendResult', true, 'Template enviada OK' + (msgId ? ' — id: ' + msgId : ''));
                    } else {
                        var errMsg = json.message || JSON.stringify(json).slice(0, 300);
                        setResult('templateSendResult', false, 'Error: ' + errMsg);
                    }
                } catch (e) {
                    setResult('templateSendResult', false, 'Error de red: ' + e.message);
                }
            }

            function insertDataVariable() {
                var varName = document.getElementById('varName').value.trim();
                var varDefault = document.getElementById('varDefault').value.trim();
                var syntax = document.getElementById('varSyntax').value;
                if (!varName) {
                    setResult('dataBuilderResult', false, 'Escribe el nombre de la variable.');
                    return;
                }
                var vars = tryParseJson(document.getElementById('queryVariables').value, {});
                if (!vars || typeof vars !== 'object') { vars = {}; }
                vars[varName] = {
                    default: varDefault || '',
                    required: true,
                    type: 'string',
                    syntax: syntax
                };
                document.getElementById('queryVariables').value = stringify(vars);
                setResult('dataBuilderResult', true, 'Variable agregada: ' + varName);
            }

            function buildQueryPreview(mode, fields, from, joins, whereRaw, groupBy, having, orderBy, limit, offset) {
                var selectPart = fields.length ? fields.join(', ') : '*';
                var base = '';
                if (mode === 'show') {
                    base = 'SHOW ' + selectPart + ' FROM ' + (from || 'tabla_objetivo');
                } else {
                    base = 'SELECT ' + selectPart + ' FROM ' + (from || 'tabla_objetivo');
                }

                joins.forEach(function(j) {
                    base += '\\n' + j;
                });
                if (whereRaw) { base += '\\nWHERE ' + whereRaw; }
                if (groupBy.length) { base += '\\nGROUP BY ' + groupBy.join(', '); }
                if (having) { base += '\\nHAVING ' + having; }
                if (orderBy) { base += '\\nORDER BY ' + orderBy; }
                if (limit) { base += '\\nLIMIT ' + limit; }
                if (offset) { base += '\\nOFFSET ' + offset; }
                return base + ';';
            }

            function generateDataBlueprint() {
                var source = document.getElementById('dataSource').value;
                var mode = document.getElementById('queryMode').value;
                var fields = csvToList(document.getElementById('queryFields').value);
                var from = document.getElementById('queryFrom').value.trim();
                var joins = document.getElementById('queryJoin').value.split('\\n').map(function(v){ return v.trim(); }).filter(Boolean);
                var whereRaw = document.getElementById('queryWhere').value.trim();
                var groupBy = csvToList(document.getElementById('queryGroupBy').value);
                var having = document.getElementById('queryHaving').value.trim();
                var orderBy = document.getElementById('queryOrderBy').value.trim();
                var limit = document.getElementById('queryLimit').value.trim();
                var offset = document.getElementById('queryOffset').value.trim();
                var variables = tryParseJson(document.getElementById('queryVariables').value, {});

                if (!from) {
                    setResult('dataBuilderResult', false, 'Debes completar FROM (tabla/vista/sheet).');
                    return;
                }

                var sql = buildQueryPreview(mode, fields, from, joins, whereRaw, groupBy, having, orderBy, limit, offset);
                document.getElementById('queryPreview').value = sql;

                var blueprint = {
                    module: 'shopifysql-beta',
                    name: 'consulta_' + Date.now(),
                    source: source,
                    mode: mode,
                    clauses: {
                        showOrSelect: fields,
                        from: from,
                        joins: joins,
                        where: whereRaw,
                        groupBy: groupBy,
                        having: having,
                        orderBy: orderBy,
                        limit: limit ? Number(limit) : null,
                        offset: offset ? Number(offset) : null
                    },
                    variables: (variables && typeof variables === 'object') ? variables : {},
                    sqlPreview: sql,
                    execution: {
                        active: false,
                        connected: false,
                        notes: 'Blueprint local. Sin conexion a Shopify/SQL/Sheets y sin integracion con campanas.'
                    }
                };

                document.getElementById('dataBlueprintOutput').value = stringify(blueprint);
                setResult('dataBuilderResult', true, 'Blueprint generado. Aun no esta conectado a fuentes de datos.');
            }

            function copyDataBlueprint() {
                var val = document.getElementById('dataBlueprintOutput').value;
                if (!val.trim()) {
                    setResult('dataBuilderResult', false, 'Primero genera el blueprint.');
                    return;
                }
                navigator.clipboard.writeText(val).then(function(){
                    setResult('dataBuilderResult', true, 'Blueprint copiado al portapapeles.');
                });
            }

            function resetDataBlueprint() {
                document.getElementById('dataSource').value = 'shopify-crm';
                document.getElementById('queryMode').value = 'show';
                document.getElementById('queryFields').value = '';
                document.getElementById('queryFrom').value = '';
                document.getElementById('queryJoin').value = '';
                document.getElementById('queryWhere').value = '';
                document.getElementById('queryGroupBy').value = '';
                document.getElementById('queryHaving').value = '';
                document.getElementById('queryOrderBy').value = '';
                document.getElementById('queryLimit').value = '';
                document.getElementById('queryOffset').value = '';
                document.getElementById('varSyntax').value = 'mustache';
                document.getElementById('varName').value = '';
                document.getElementById('varDefault').value = '';
                document.getElementById('queryVariables').value = stringify({});
                document.getElementById('queryPreview').value = '';
                document.getElementById('dataBlueprintOutput').value = '';
                setResult('dataBuilderResult', true, 'Formulario limpio.');
            }

            // ---- INTERACTIVE BUILDER ----
            var interactiveState = { buttons: [], sections: [{ title: '', rows: [{ title: '', description: '' }] }] };

            function saveBtnValues() {
                document.querySelectorAll('[data-ibtn]').forEach(function(inp) {
                    interactiveState.buttons[parseInt(inp.getAttribute('data-ibtn'))] = inp.value;
                });
            }

            function saveListValues() {
                document.querySelectorAll('[data-isect]').forEach(function(inp) {
                    var si = parseInt(inp.getAttribute('data-isect'));
                    if (interactiveState.sections[si]) interactiveState.sections[si].title = inp.value;
                });
                document.querySelectorAll('[data-irow-t]').forEach(function(inp) {
                    var p = inp.getAttribute('data-irow-t').split('-'), si = parseInt(p[0]), ri = parseInt(p[1]);
                    if (interactiveState.sections[si] && interactiveState.sections[si].rows[ri])
                        interactiveState.sections[si].rows[ri].title = inp.value;
                });
                document.querySelectorAll('[data-irow-d]').forEach(function(inp) {
                    var p = inp.getAttribute('data-irow-d').split('-'), si = parseInt(p[0]), ri = parseInt(p[1]);
                    if (interactiveState.sections[si] && interactiveState.sections[si].rows[ri])
                        interactiveState.sections[si].rows[ri].description = inp.value;
                });
            }

            function renderInteractiveBuilder() {
                var type = document.getElementById('interactiveType').value;
                var c = document.getElementById('interactiveBuilderFields');
                var h = '';
                h += '<div class="builder-group"><h4>HEADER (opcional)</h4><input id="iHeader" placeholder="Texto de header (opcional)" /></div>';
                h += '<div class="builder-group"><h4>BODY (requerido)</h4><textarea id="iBody" placeholder="Cuerpo del mensaje"></textarea></div>';
                h += '<div class="builder-group"><h4>FOOTER (opcional)</h4><input id="iFooter" placeholder="Pie de mensaje (opcional)" /></div>';
                if (type === 'button') {
                    h += '<div class="builder-group"><h4>BOTONES (max 3 · max 20 chars)</h4>';
                    for (var i = 0; i < interactiveState.buttons.length; i++) {
                        h += '<input style="margin-bottom:6px" maxlength="20" data-ibtn="' + i + '" value="' + (interactiveState.buttons[i] || '') + '" placeholder="Titulo boton ' + (i+1) + '" />';
                    }
                    if (interactiveState.buttons.length < 3) {
                        h += '<button class="secondary" id="addIBtn" style="margin-top:4px;width:auto;padding:6px 14px">+ Boton</button>';
                    }
                    h += '</div>';
                }
                if (type === 'list') {
                    h += '<div class="builder-group"><h4>ETIQUETA DEL BOTON</h4><input id="iListBtn" placeholder="Ver opciones" /></div>';
                    h += '<div class="builder-group"><h4>SECCIONES</h4><div id="iSections">';
                    interactiveState.sections.forEach(function(section, si) {
                        h += '<div class="builder-group">';
                        h += '<input data-isect="' + si + '" value="' + (section.title || '') + '" placeholder="Nombre seccion ' + (si+1) + '" />';
                        section.rows.forEach(function(row, ri) {
                            h += '<div style="display:flex;gap:6px;margin-top:6px">';
                            h += '<input style="flex:2" maxlength="24" data-irow-t="' + si + '-' + ri + '" value="' + (row.title || '') + '" placeholder="Titulo opcion (max 24)" />';
                            h += '<input style="flex:3" data-irow-d="' + si + '-' + ri + '" value="' + (row.description || '') + '" placeholder="Descripcion opcional" />';
                            h += '</div>';
                        });
                        h += '<button class="secondary" data-addrow="' + si + '" style="margin-top:6px;width:auto;padding:5px 12px">+ Fila</button>';
                        h += '</div>';
                    });
                    h += '</div><button class="secondary" id="addISect" style="margin-top:6px;width:auto;padding:6px 14px">+ Seccion</button></div>';
                }
                c.innerHTML = h;
                var addBtnEl = document.getElementById('addIBtn');
                if (addBtnEl) { addBtnEl.addEventListener('click', function() { saveBtnValues(); interactiveState.buttons.push(''); renderInteractiveBuilder(); }); }
                var addSectEl = document.getElementById('addISect');
                if (addSectEl) { addSectEl.addEventListener('click', function() { saveListValues(); interactiveState.sections.push({ title: '', rows: [{ title: '', description: '' }] }); renderInteractiveBuilder(); }); }
                document.querySelectorAll('[data-addrow]').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var si = parseInt(btn.getAttribute('data-addrow'));
                        saveListValues(); interactiveState.sections[si].rows.push({ title: '', description: '' }); renderInteractiveBuilder();
                    });
                });
            }

            function buildInteractivePayload() {
                var type = document.getElementById('interactiveType').value;
                var hEl = document.getElementById('iHeader'), bEl = document.getElementById('iBody'), fEl = document.getElementById('iFooter');
                var interactive = { type: type };
                if (hEl && hEl.value.trim()) interactive.header = { type: 'text', text: hEl.value.trim() };
                if (bEl && bEl.value.trim()) interactive.body = { text: bEl.value.trim() };
                if (fEl && fEl.value.trim()) interactive.footer = { text: fEl.value.trim() };
                if (type === 'button') {
                    saveBtnValues();
                    interactive.action = { buttons: interactiveState.buttons.filter(function(t){ return t && t.trim(); }).map(function(title, i) { return { type: 'reply', reply: { id: 'btn_' + i, title: title.trim().slice(0,20) } }; }) };
                }
                if (type === 'list') {
                    saveListValues();
                    var lbEl = document.getElementById('iListBtn');
                    interactive.action = {
                        button: (lbEl && lbEl.value.trim()) ? lbEl.value.trim() : 'Ver opciones',
                        sections: interactiveState.sections.map(function(section, si) {
                            return { title: section.title || ('Seccion ' + (si+1)), rows: section.rows.filter(function(r){ return r.title && r.title.trim(); }).map(function(row, ri) { return { id: 'row_' + si + '_' + ri, title: row.title.trim().slice(0,24), description: row.description ? row.description.trim() : undefined }; }) };
                        }).filter(function(s){ return s.rows.length > 0; })
                    };
                }
                return interactive;
            }

            async function sendInteractive() {
                var to = document.getElementById('interactiveTo').value.trim();
                if (!to) { setResult('interactiveResult', false, 'Ingresa el numero destino.'); return; }
                var interactive = buildInteractivePayload();
                if (!interactive.body) { setResult('interactiveResult', false, 'El cuerpo BODY es obligatorio.'); return; }
                setResult('interactiveResult', true, 'Enviando...');
                try {
                    var res = await fetch('/send-interactive', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(withBrandPayload({ to: to, interactive: interactive }))
                    });
                    var json = await res.json();
                    if (json.ok) {
                        var msgId = json.data && json.data.messages && json.data.messages[0] ? json.data.messages[0].id : '';
                        setResult('interactiveResult', true, 'Enviado OK' + (msgId ? ' — id: ' + msgId : ''));
                    } else {
                        setResult('interactiveResult', false, 'Error: ' + (json.message || JSON.stringify(json).slice(0,300)));
                    }
                } catch(e) {
                    setResult('interactiveResult', false, 'Error de red: ' + e.message);
                }
            }
            // ---- / INTERACTIVE BUILDER ----

            async function boot() {
                document.getElementById('singleTo').value = '573204545484';
                document.getElementById('interactiveTo').value = '573204545484';
                document.getElementById('campaignMessage').value = stringify({ type: 'template', templateName: '', languageCode: 'es', components: [] });
                document.getElementById('campaignAntiSpam').value = stringify({ timingMs: 1400, batchSize: 30, batchPauseMs: 25000, maxRetries: 2, retryDelayMs: 3000, jitterMs: 400 });
                document.getElementById('queryVariables').value = stringify({});
                updateStartAtPreview();
                var rememberedView = 'campaigns';
                var rememberedAdvanced = '0';
                var rememberedStep = '0';
                try {
                    rememberedView = localStorage.getItem('meteoro.mainView') || 'campaigns';
                    rememberedAdvanced = localStorage.getItem('meteoro.advanced') || '0';
                    rememberedStep = localStorage.getItem('meteoro.campaignStep') || '0';
                } catch (_e) {}
                window._campaignStepIndex = Number(rememberedStep) || 0;
                setMainView((rememberedView === 'data' || rememberedView === 'calendar') ? rememberedView : 'campaigns');
                setAdvancedMode(rememberedAdvanced === '1');
                syncSinglePayloadByType();
                renderInteractiveBuilder();
                setupFlowSwipe();
                renderAstroTelemetry();
                await loadBrands();
                await Promise.all([loadCampaigns(), loadLogs(), refreshTemplates()]);
            }

            document.getElementById('singleType').addEventListener('change', syncSinglePayloadByType);
            document.getElementById('singleSendBtn').addEventListener('click', sendSingle);
            document.getElementById('mediaUploadBtn').addEventListener('click', uploadMediaFile);
            document.getElementById('campaignSendBtn').addEventListener('click', createCampaign);
            document.getElementById('refreshTemplatesBtn').addEventListener('click', refreshTemplates);
            document.getElementById('templateName').addEventListener('change', function(e){ loadTemplateRequirements(e.target.value); });
            document.getElementById('generateTemplateInputsBtn').addEventListener('click', generateTemplateInputs);
            document.getElementById('applyTemplateToSingleBtn').addEventListener('click', copyTemplateToSingle);
            document.getElementById('copyTemplateToCampaignBtn').addEventListener('click', copyTemplateToCampaign);
            document.getElementById('sendTemplateNowBtn').addEventListener('click', sendTemplateNow);
            document.getElementById('copyMediaIdBtn').addEventListener('click', function() {
                var val = document.getElementById('mediaIdDisplay').value;
                if (val) {
                    navigator.clipboard.writeText(val).then(function(){ setResult('mediaResult', true, 'Copiado: ' + val); });
                }
            });
            document.getElementById('useMediaIdBtn').addEventListener('click', function() {
                var m = window._lastUploadedMedia;
                if (!m) return;
                if (m.brand && m.brand !== getSelectedBrand()) {
                    setResult('mediaResult', false, 'Ese media_id fue subido en ' + m.brand + '. Cambia a esa marca o vuelve a subir el archivo en la marca actual.');
                    return;
                }
                document.getElementById('singleType').value = 'media';
                document.getElementById('singlePayload').value = stringify({ mediaType: m.mediaType, mediaId: m.mediaId, caption: '' });
                setResult('mediaResult', true, 'Listo! Ajusta el tipo en Card 1 y presiona Enviar.');
            });
            document.getElementById('interactiveType').addEventListener('change', function() {
                interactiveState.buttons = [];
                interactiveState.sections = [{ title: '', rows: [{ title: '', description: '' }] }];
                renderInteractiveBuilder();
            });
            document.getElementById('interactiveSendBtn').addEventListener('click', sendInteractive);
            document.getElementById('addVarBtn').addEventListener('click', insertDataVariable);
            document.getElementById('generateDataBlueprintBtn').addEventListener('click', generateDataBlueprint);
            document.getElementById('copyDataBlueprintBtn').addEventListener('click', copyDataBlueprint);
            document.getElementById('resetDataBlueprintBtn').addEventListener('click', resetDataBlueprint);
            document.getElementById('navCampaignsBtn').addEventListener('click', function() { setMainView('campaigns'); });
            document.getElementById('navDataBtn').addEventListener('click', function() { setMainView('data'); });
            document.getElementById('navCalendarBtn').addEventListener('click', function() { setMainView('calendar'); });
            document.getElementById('toggleAdvancedBtn').addEventListener('click', function() {
                var isSimple = document.body.classList.contains('simple-mode');
                setAdvancedMode(isSimple);
            });
            document.getElementById('openGuideBtn').addEventListener('click', function() { toggleAstroGuide(); });
            document.getElementById('closeGuideBtn').addEventListener('click', function() { toggleAstroGuide(false); });
            document.getElementById('copyBrandPhoneId').addEventListener('click', function() {
                writeTextToClipboard(document.getElementById('brandPhoneId').textContent, 'singleResult');
            });
            document.getElementById('copyBrandWabaId').addEventListener('click', function() {
                writeTextToClipboard(document.getElementById('brandWabaId').textContent, 'singleResult');
            });
            document.getElementById('copyBrandBusinessId').addEventListener('click', function() {
                writeTextToClipboard(document.getElementById('brandBusinessId').textContent, 'singleResult');
            });
            document.getElementById('scheduleNowBtn').addEventListener('click', function() { setSchedulePreset('now'); });
            document.getElementById('scheduleIn30Btn').addEventListener('click', function() { setSchedulePreset('in30'); });
            document.getElementById('scheduleTonightBtn').addEventListener('click', function() { setSchedulePreset('today20'); });
            document.getElementById('scheduleTomorrowBtn').addEventListener('click', function() { setSchedulePreset('tomorrow9'); });
            document.getElementById('scheduleOpenBtn').addEventListener('click', function() { toggleSchedulePopover(true); });
            document.getElementById('scheduleApplyBtn').addEventListener('click', applyScheduleFromPopover);
            document.getElementById('scheduleCloseBtn').addEventListener('click', function() { toggleSchedulePopover(false); });
            document.getElementById('startAtPicker').addEventListener('change', updateStartAtPreview);
            document.getElementById('startAt').addEventListener('input', updateStartAtPreview);
            document.getElementById('flowPrevBtn').addEventListener('click', function() {
                setCampaignStep((window._campaignStepIndex || 0) - 1);
            });
            document.getElementById('flowNextBtn').addEventListener('click', function() {
                setCampaignStep((window._campaignStepIndex || 0) + 1);
            });
            document.getElementById('calendarPrevMonthBtn').addEventListener('click', function() { moveCalendarMonth(-1); });
            document.getElementById('calendarNextMonthBtn').addEventListener('click', function() { moveCalendarMonth(1); });
            document.getElementById('calendarTodayBtn').addEventListener('click', jumpCalendarToday);
            document.getElementById('calendarGoToSchedulerBtn').addEventListener('click', openSchedulerForCalendarDay);
            document.getElementById('calendarQuickCloseBtn').addEventListener('click', function() { toggleCalendarQuickModal(false); });
            document.getElementById('calendarQuickApplyBtn').addEventListener('click', applyCalendarQuickModal);
            document.getElementById('calendarQuickModal').addEventListener('click', function(ev) {
                if (ev.target && ev.target.id === 'calendarQuickModal') {
                    toggleCalendarQuickModal(false);
                }
            });
            document.getElementById('calendarGrid').addEventListener('click', function(ev) {
                var planBtn = ev.target && ev.target.closest('[data-day-plan]');
                if (planBtn) {
                    var dayKey = planBtn.getAttribute('data-day-plan');
                    openCalendarQuickFromDay(dayKey);
                    return;
                }
                if (ev.target && ev.target.closest('input[type="time"]')) {
                    return;
                }
                var dayEl = ev.target && ev.target.closest('[data-day-key]');
                if (!dayEl) { return; }
                window._calendarSelectedKey = dayEl.getAttribute('data-day-key');
                var selectedDate = toLocalDateFromYmd(window._calendarSelectedKey);
                if (selectedDate) {
                    window._calendarCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
                }
                renderCalendarMonth();
            });
            document.querySelectorAll('.flow-chip').forEach(function(chip) {
                chip.addEventListener('click', function() {
                    setCampaignStep(Number(chip.getAttribute('data-go-step')) || 0);
                });
            });

      boot();
            setInterval(function(){ loadCampaigns(); loadLogs(); }, 5000);
        setInterval(function(){ renderAstroTelemetry(); }, 30000);
    </script>
  </body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    return res.send(html);
});

app.get("/dashboard", (_req, res) => {
    return res.redirect("/platform");
});

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
});

app.post("/webhook", (req, res) => {
    appendLog({
        type: "webhook_event",
        payload: req.body,
    });

    return res.status(200).send("EVENT_RECEIVED");
});

app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError && "body" in err) {
        return res.status(400).json({
            ok: false,
            message: "JSON invalido en el body",
        });
    }

    return res.status(500).json({
        ok: false,
        message: "Error interno del servidor",
    });
});

server = app.listen(port, () => {
    console.log(`Servidor listo en http://localhost:${port}`);
    console.log(`Dashboard en http://localhost:${port}/dashboard`);
});
