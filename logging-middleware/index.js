require('dotenv').config();
const axios = require('axios');

let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticates with the evaluation service and caches the bearer token.
 */
async function getAuthToken() {
    // If we have a valid token, return it
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
        throw new Error('Missing authentication environment variables.');
    }

    try {
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
        
        // Handle if expires_in is a unix timestamp vs seconds from now
        if (expiresIn > 1000000000) {
            tokenExpiry = expiresIn * 1000; // Convert to milliseconds
        } else {
            tokenExpiry = Date.now() + (expiresIn * 1000);
        }

        return cachedToken;
    } catch (error) {
        console.error('[Logging Middleware] Failed to authenticate:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Reusable function to log to the remote server.
 * @param {string} stack - 'backend' or 'frontend'
 * @param {string} level - 'debug', 'info', 'warn', 'error', 'fatal'
 * @param {string} pkg - 'router', 'controller', 'cron_job', 'db', 'module', 'middleware', 'repository', 'model', 'service' (or frontend packages)
 * @param {string} message - descriptive log message
 */
async function log(stack, level, pkg, message) {
    try {
        const token = await getAuthToken();
        
        const response = await axios.post('http://4.224.186.213/evaluation-service/log', {
            stack,
            level,
            package: pkg,
            message
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        // Debug output locally
        // console.log(`[Remote Log Success] ${level.toUpperCase()}: ${message}`);
        return response.data;
    } catch (error) {
        console.error('[Logging Middleware] Failed to send log:', error.response?.data || error.message);
    }
}

module.exports = { log };
