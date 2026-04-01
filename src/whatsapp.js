const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

function assertCredentials({ phoneNumberId, accessToken }) {
    if (!phoneNumberId) {
        throw new Error("Falta phoneNumberId. Envia phoneNumberId en el body o WHATSAPP_PHONE_NUMBER_ID en .env");
    }

    if (!accessToken) {
        throw new Error("Falta accessToken. Envia accessToken en el body o WHATSAPP_ACCESS_TOKEN en .env");
    }
}

async function graphRequest({
    path,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
    method = "GET",
    body,
    rawBody,
    extraHeaders = {},
}) {
    const url = `https://graph.facebook.com/${apiVersion}${path}`;
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        ...extraHeaders,
    };

    if (body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
        method,
        headers,
        body: rawBody || (body ? JSON.stringify(body) : undefined),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const apiError = data?.error?.message || "Error desconocido al llamar WhatsApp Cloud API";
        const error = new Error(apiError);
        error.status = response.status;
        error.response = data;
        throw error;
    }

    return data;
}

function inferBodyPlaceholderCount(text) {
    if (!text || typeof text !== "string") {
        return 0;
    }
    const matches = text.match(/{{\d+}}/g);
    return matches ? matches.length : 0;
}

function extractTemplateRequirements(template) {
    const req = {
        templateName: template?.name || "",
        language: template?.language || "",
        header: null,
        bodyPlaceholderCount: 0,
        buttons: [],
    };

    for (const component of template?.components || []) {
        const type = String(component.type || "").toUpperCase();

        if (type === "HEADER") {
            const format = String(component.format || "TEXT").toLowerCase();
            req.header = {
                format,
                placeholderCount: inferBodyPlaceholderCount(component.text),
            };
        }

        if (type === "BODY") {
            req.bodyPlaceholderCount = inferBodyPlaceholderCount(component.text);
        }

        if (type === "BUTTONS" && Array.isArray(component.buttons)) {
            component.buttons.forEach((button, index) => {
                req.buttons.push({
                    index,
                    type: String(button.type || "").toLowerCase(),
                    text: button.text || "",
                    requiresDynamicText: /{{\d+}}/.test(String(button.url || "")),
                });
            });
        }
    }

    return req;
}

function buildTemplateComponentsFromInputs(templateInputs = {}) {
    const components = [];

    if (templateInputs.header) {
        const header = templateInputs.header;
        if (header.type === "text" && header.text) {
            components.push({
                type: "header",
                parameters: [{ type: "text", text: String(header.text) }],
            });
        }

        if (["image", "video", "document"].includes(header.type)) {
            const parameter = { type: header.type };
            if (header.link) {
                parameter[header.type] = { link: header.link };
            }
            if (header.mediaId) {
                parameter[header.type] = { id: header.mediaId };
            }
            components.push({ type: "header", parameters: [parameter] });
        }
    }

    if (Array.isArray(templateInputs.body) && templateInputs.body.length > 0) {
        components.push({
            type: "body",
            parameters: templateInputs.body.map((entry) => {
                if (entry && typeof entry === "object" && entry.type) {
                    return entry;
                }
                return { type: "text", text: String(entry) };
            }),
        });
    }

    if (Array.isArray(templateInputs.buttons)) {
        for (const button of templateInputs.buttons) {
            components.push({
                type: "button",
                sub_type: button.subType || "url",
                index: String(button.index || 0),
                parameters: [{ type: "text", text: String(button.text || "") }],
            });
        }
    }

    return components;
}

function validateTemplateInputs(requirements, templateInputs = {}) {
    const errors = [];

    const expectedBody = Number(requirements?.bodyPlaceholderCount || 0);
    const currentBody = Array.isArray(templateInputs.body) ? templateInputs.body.length : 0;
    if (expectedBody !== currentBody) {
        errors.push(`BODY requiere ${expectedBody} parametros y se enviaron ${currentBody}.`);
    }

    if (requirements?.header) {
        const expected = requirements.header.format;
        const headerPlaceholderCount = Number(requirements.header.placeholderCount || 0);
        const headerIsRequired = ["image", "video", "document"].includes(expected) || headerPlaceholderCount > 0;

        if (!templateInputs.header) {
            if (headerIsRequired) {
                errors.push(`HEADER requiere tipo ${expected}.`);
            }
        } else if (templateInputs.header.type !== expected) {
            errors.push(`HEADER debe ser tipo ${expected}.`);
        } else if (["image", "video", "document"].includes(expected)) {
            if (!templateInputs.header.link && !templateInputs.header.mediaId) {
                errors.push(`HEADER ${expected} requiere link o mediaId.`);
            }
        } else if (expected === "text") {
            if (headerPlaceholderCount > 0 && !templateInputs.header.text) {
                errors.push("HEADER text requiere header.text.");
            }
        }
    }

    const requiredButtonCount = requirements?.buttons?.filter((b) => b.requiresDynamicText).length || 0;
    const sentButtons = Array.isArray(templateInputs.buttons) ? templateInputs.buttons.length : 0;
    if (requiredButtonCount !== sentButtons) {
        errors.push(`BUTTONS dinamicos requieren ${requiredButtonCount} valores y se enviaron ${sentButtons}.`);
    }

    return errors;
}

function buildTemplateComponents(input) {
    if (!Array.isArray(input) || input.length === 0) {
        return undefined;
    }

    return input;
}

function validateSendTemplatePayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== "object") {
        return ["El body debe ser un JSON valido."];
    }

    if (!payload.to || typeof payload.to !== "string") {
        errors.push("'to' es obligatorio y debe ser string (numero destino en formato internacional). ");
    }

    if (!payload.templateName || typeof payload.templateName !== "string") {
        errors.push("'templateName' es obligatorio y debe ser string.");
    }

    if (payload.languageCode && typeof payload.languageCode !== "string") {
        errors.push("'languageCode' debe ser string.");
    }

    if (payload.components && !Array.isArray(payload.components)) {
        errors.push("'components' debe ser un arreglo si es enviado.");
    }

    return errors;
}

async function sendTemplateMessage({
    to,
    templateName,
    languageCode = "es",
    components,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    const body = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
            name: templateName,
            language: {
                code: languageCode,
            },
            components: buildTemplateComponents(components),
        },
    };

    if (!body.template.components) {
        delete body.template.components;
    }

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body,
    });
}

async function sendTextMessage({
    to,
    text,
    previewUrl = false,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body: {
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: {
                body: text,
                preview_url: Boolean(previewUrl),
            },
        },
    });
}

async function sendRawMessage({
    rawMessage,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    if (!rawMessage || typeof rawMessage !== "object") {
        throw new Error("rawMessage debe ser un objeto JSON valido.");
    }

    if (!rawMessage.to || !rawMessage.type) {
        throw new Error("rawMessage debe incluir al menos 'to' y 'type'.");
    }

    const body = {
        messaging_product: "whatsapp",
        recipient_type: rawMessage.recipient_type || "individual",
        ...rawMessage,
    };

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body,
    });
}

async function markMessageAsRead({
    messageId,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    if (!messageId) {
        throw new Error("messageId es obligatorio.");
    }

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body: {
            messaging_product: "whatsapp",
            status: "read",
            message_id: messageId,
        },
    });
}

function buildMediaObject({ mediaType, link, mediaId, caption, filename }) {
    const media = {};

    if (link) {
        media.link = link;
    }

    if (mediaId) {
        media.id = mediaId;
    }

    if (caption && ["image", "video", "document"].includes(mediaType)) {
        media.caption = caption;
    }

    if (filename && mediaType === "document") {
        media.filename = filename;
    }

    return media;
}

async function sendMediaMessage({
    to,
    mediaType,
    link,
    mediaId,
    caption,
    filename,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    const allowedTypes = ["image", "video", "audio", "document", "sticker"];
    if (!allowedTypes.includes(mediaType)) {
        throw new Error(`mediaType invalido. Usa uno de: ${allowedTypes.join(", ")}`);
    }

    if (!link && !mediaId) {
        throw new Error("Debes enviar 'link' o 'mediaId' para multimedia.");
    }

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body: {
            messaging_product: "whatsapp",
            to,
            type: mediaType,
            [mediaType]: buildMediaObject({ mediaType, link, mediaId, caption, filename }),
        },
    });
}

async function sendInteractiveMessage({
    to,
    interactive,
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    if (!interactive || !interactive.type) {
        throw new Error("interactive.type es obligatorio (button o list).");
    }

    if (!interactive.body || !interactive.body.text) {
        throw new Error("interactive.body.text es obligatorio.");
    }

    const allowedTypes = ["button", "list", "product", "product_list", "flow", "catalog_message"];
    if (!allowedTypes.includes(interactive.type)) {
        throw new Error(`interactive.type invalido. Opciones: ${allowedTypes.join(", ")}`);
    }

    return graphRequest({
        path: `/${phoneNumberId}/messages`,
        accessToken,
        apiVersion,
        method: "POST",
        body: {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive,
        },
    });
}

async function listTemplates({ businessAccountId, accessToken, apiVersion = DEFAULT_API_VERSION }) {
    if (!businessAccountId) {
        throw new Error("Falta businessAccountId para consultar plantillas.");
    }

    if (!accessToken) {
        throw new Error("Falta accessToken. Envia accessToken o WHATSAPP_ACCESS_TOKEN en .env");
    }

    return graphRequest({
        path: `/${businessAccountId}/message_templates?fields=id,name,status,category,language,components`,
        accessToken,
        apiVersion,
        method: "GET",
    });
}

async function uploadMedia({
    phoneNumberId,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
    fileBuffer,
    filename,
    mimeType,
}) {
    assertCredentials({ phoneNumberId, accessToken });

    if (!fileBuffer || !filename) {
        throw new Error("fileBuffer y filename son obligatorios para subir media.");
    }

    const resolvedMime = mimeType || "application/octet-stream";
    const form = new FormData();
    const blob = new Blob([fileBuffer], { type: resolvedMime });
    form.append("messaging_product", "whatsapp");
    form.append("type", resolvedMime);
    form.append("file", blob, filename);

    return graphRequest({
        path: `/${phoneNumberId}/media`,
        accessToken,
        apiVersion,
        method: "POST",
        rawBody: form,
    });
}

module.exports = {
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
};
