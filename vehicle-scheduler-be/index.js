require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { log } = require('logging-middleware');

const app = express();
const PORT = process.env.PORT || 3000;


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

app.get('/schedule', async (req, res) => {
    try {
        await log('backend', 'info', 'service', 'Started vehicle scheduling process');

        const token = await getAuthToken();
        const headers = { Authorization: `Bearer ${token}` };

       
        await log('backend', 'info', 'service', 'Fetching depots data');
        const depotsRes = await axios.get('http://4.224.186.213/evaluation-service/depots', { headers });
        const depots = depotsRes.data.depots || [];
        
        
        const totalBudget = depots.reduce((sum, depot) => sum + depot.MechanicHours, 0);

        
        await log('backend', 'info', 'service', 'Fetching vehicles data');
        const vehiclesRes = await axios.get('http://4.224.186.213/evaluation-service/vehicles', { headers });
        const vehicles = vehiclesRes.data.vehicles || [];

       
        await log('backend', 'info', 'service', `Optimizing scheduling for ${vehicles.length} vehicles with budget ${totalBudget}`);
        
    
        const sortedVehicles = [...vehicles].sort((a, b) => {
            const ratioA = a.Impact / a.Duration;
            const ratioB = b.Impact / b.Duration;
            return ratioB - ratioA;
        });

        let currentHours = 0;
        let totalImpact = 0;
        const selectedTasks = [];

        for (const vehicle of sortedVehicles) {
            if (currentHours + vehicle.Duration <= totalBudget) {
                currentHours += vehicle.Duration;
                totalImpact += vehicle.Impact;
                selectedTasks.push(vehicle.TaskID);
            }
        }

        const result = {
            scheduledTasksCount: selectedTasks.length,
            totalHoursUsed: currentHours,
            totalImpactScore: totalImpact,
            budget: totalBudget,
            selectedTaskIDs: selectedTasks
        };

        await log('backend', 'info', 'service', `Scheduling complete. Impact: ${totalImpact}, Hours Used: ${currentHours}`);

        res.status(200).json(result);
    } catch (error) {
        const errorDetails = error.response ? error.response.data : error.message;
        await log('backend', 'error', 'service', `Error during scheduling: ${error.message}`);
        res.status(500).json({ error: 'Failed to complete scheduling', details: errorDetails });
    }
});

app.listen(PORT, () => {
    console.log(`Vehicle Scheduler running on port ${PORT}`);
    
});
