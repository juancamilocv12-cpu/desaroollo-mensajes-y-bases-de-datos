const campaignLogs = [];
const campaigns = new Map();

function appendLog(entry) {
    campaignLogs.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        ...entry,
    });

    if (campaignLogs.length > 5000) {
        campaignLogs.shift();
    }
}

function saveCampaign(campaign) {
    campaigns.set(campaign.id, campaign);
}

function getCampaign(campaignId) {
    return campaigns.get(campaignId);
}

function listCampaigns() {
    return Array.from(campaigns.values()).sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
}

function getLogs(limit = 200) {
    return campaignLogs.slice(-Math.max(1, Math.min(limit, 5000)));
}

module.exports = {
    appendLog,
    saveCampaign,
    getCampaign,
    listCampaigns,
    getLogs,
};
