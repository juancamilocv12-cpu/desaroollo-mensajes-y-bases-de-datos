const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.APP_DB_PATH || path.join(process.cwd(), "data", "meteoro.sqlite");
const maxLogs = Math.max(1000, Number(process.env.APP_DB_MAX_LOGS || 20000));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        start_at TEXT,
        status TEXT,
        message_type TEXT,
        total INTEGER,
        sent INTEGER,
        failed INTEGER,
        processed INTEGER,
        base_reference TEXT,
        payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        campaign_id TEXT,
        type TEXT,
        status TEXT,
        attempt INTEGER,
        error TEXT,
        to_number TEXT,
        payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_campaign_id ON logs(campaign_id);
`);

const insertLogStmt = db.prepare(`
    INSERT INTO logs (id, timestamp, campaign_id, type, status, attempt, error, to_number, payload_json)
    VALUES (@id, @timestamp, @campaignId, @type, @status, @attempt, @error, @to, @payload_json)
`);

const pruneLogsStmt = db.prepare(`
    DELETE FROM logs
    WHERE id NOT IN (
        SELECT id
        FROM logs
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
    )
`);

const upsertCampaignStmt = db.prepare(`
    INSERT INTO campaigns (
        id, created_at, updated_at, start_at, status, message_type, total, sent, failed, processed, base_reference, payload_json
    ) VALUES (
        @id, @created_at, @updated_at, @start_at, @status, @message_type, @total, @sent, @failed, @processed, @base_reference, @payload_json
    )
    ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        start_at = excluded.start_at,
        status = excluded.status,
        message_type = excluded.message_type,
        total = excluded.total,
        sent = excluded.sent,
        failed = excluded.failed,
        processed = excluded.processed,
        base_reference = excluded.base_reference,
        payload_json = excluded.payload_json
`);

const getCampaignStmt = db.prepare(`
    SELECT payload_json
    FROM campaigns
    WHERE id = ?
`);

const listCampaignsStmt = db.prepare(`
    SELECT payload_json
    FROM campaigns
    ORDER BY created_at DESC, id DESC
`);

const getLogsStmt = db.prepare(`
    SELECT payload_json
    FROM logs
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
`);

function parseStoredJson(text) {
    try {
        return JSON.parse(text);
    } catch (_error) {
        return null;
    }
}

function appendLog(entry) {
    const payload = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        ...entry,
    };

    insertLogStmt.run({
        ...payload,
        payload_json: JSON.stringify(payload),
    });
    pruneLogsStmt.run(maxLogs);
    return payload;
}

function saveCampaign(campaign) {
    const now = new Date().toISOString();
    const payload = {
        ...campaign,
        createdAt: campaign.createdAt || now,
        updatedAt: now,
    };

    upsertCampaignStmt.run({
        id: payload.id,
        created_at: payload.createdAt,
        updated_at: payload.updatedAt,
        start_at: payload.startAt || null,
        status: payload.status || null,
        message_type: payload.messageType || null,
        total: Number(payload.total || 0),
        sent: Number(payload.sent || 0),
        failed: Number(payload.failed || 0),
        processed: Number(payload.processed || 0),
        base_reference: payload.baseReference || null,
        payload_json: JSON.stringify(payload),
    });

    return payload;
}

function getCampaign(campaignId) {
    const row = getCampaignStmt.get(campaignId);
    return row ? parseStoredJson(row.payload_json) : undefined;
}

function listCampaigns() {
    return listCampaignsStmt.all().map((row) => parseStoredJson(row.payload_json)).filter(Boolean);
}

function getLogs(limit = 200) {
    return getLogsStmt
        .all(Math.max(1, Math.min(Number(limit) || 200, maxLogs)))
        .map((row) => parseStoredJson(row.payload_json))
        .filter(Boolean)
        .reverse();
}

function getStoreHealth() {
    return {
        ok: true,
        engine: "sqlite",
        path: dbPath,
        maxLogs,
    };
}

function closeStore() {
    if (db.open) {
        db.close();
    }
}

module.exports = {
    appendLog,
    saveCampaign,
    getCampaign,
    listCampaigns,
    getLogs,
    getStoreHealth,
    closeStore,
};
