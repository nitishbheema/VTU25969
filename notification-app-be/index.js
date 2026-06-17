require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { log } = require('logging-middleware');

const app = express();
const PORT = process.env.PORT || 4000;

let cachedToken = null;
let tokenExpiry = null;

async function getAuthToken() {
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    const email = process.env.EMAIL;
    const name = process.env.NAME;
    const rollNo = process.env.ROLL_NO;
    const accessCode = process.env.ACCESS_CODE;

    if (!clientId || !clientSecret || !email || !name || !rollNo || !accessCode) {
        throw new Error('Missing Authentication environment variables');
    }

    const response = await axios.post('http://4.224.186.213/evaluation-service/auth', {
        email,
        name,
        rollNo,
        accessCode,
        clientId,
        clientSecret
    });

    cachedToken = response.data.access_token;
    const expiresIn = response.data.expires_in;
    if (expiresIn > 1000000000) {
        tokenExpiry = expiresIn * 1000;
    } else {
        tokenExpiry = Date.now() + (expiresIn * 1000);
    }

    return cachedToken;
}

const TYPE_WEIGHTS = {
    'placement': 3,
    'result': 2,
    'event': 1
};

function getWeight(type) {
    if (!type) return 0;
    return TYPE_WEIGHTS[type.toLowerCase()] || 0;
}

app.get('/priority-inbox', async (req, res) => {
    try {
        await log('backend', 'info', 'service', 'Fetching priority inbox notifications');

        const token = await getAuthToken();
        const headers = { Authorization: `Bearer ${token}` };

        const response = await axios.get('http://4.224.186.213/evaluation-service/notifications', { headers });
        const notifications = response.data.notifications || [];

        
        notifications.sort((a, b) => {
            const weightA = getWeight(a.Type);
            const weightB = getWeight(b.Type);

            if (weightA !== weightB) {
                return weightB - weightA; 
            }

            
            const timeA = new Date(a.Timestamp).getTime();
            const timeB = new Date(b.Timestamp).getTime();
            return timeB - timeA;
        });

        const top10 = notifications.slice(0, 10);

        await log('backend', 'info', 'service', `Successfully retrieved top ${top10.length} priority notifications`);

        res.status(200).json({
            count: top10.length,
            topPriorityNotifications: top10
        });

    } catch (error) {
        await log('backend', 'error', 'service', `Failed to fetch priority inbox: ${error.message}`);
        res.status(500).json({ error: 'Failed to process priority inbox', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Notification Priority Inbox running on port ${PORT}`);
});
