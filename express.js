'use strict';
// Module Dependencies
// -------------------
const express = require('express');
const bodyParser = require('body-parser');
const errorhandler = require('errorhandler');
const http = require('http');
const path = require('path');
const axios = require('axios');
const nodeCache = require('node-cache');
const jwt = require('jsonwebtoken'); // Import the JWT library
const cron = require('node-cron');

let totalProcessedRecords = 0; // Global counter for processed records
let totalReceivedRecords = 0;  // Global counter for received records
let totalNoPhoneNumberRecords = 0; // Global counter for records without phone number
// New global counters for templateField and journeyId
let templateFieldCounts = {};
let journeyIdCounts = {};

let receivedByTemplateAndJourneyCounts = {};
let processedByTemplateAndJourneyCounts = {};
let Sprinklr = {};
let MAX_LENGTH = 3000;
// Load environment variables from .env file
require('dotenv').config();

const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';

// Load environment variables 
const tokenManagerUrl = process.env.TOKEN_MANAGER_URL; // URL of the Token Manager Dyno 

// Load accounts data
const accountsData = require('./sfmc_accounts.json');

// Function to get filters for a specific MID
function getFiltersForMID(mid) {
    const account = accountsData.accounts.find(acc => acc.MID === mid);
    return account ? account.Filters : [];
}

function getHSMFiltersForMID(mid) {
    const account = accountsData.accounts.find(acc => acc.MID === mid);
    return account ? account.HSMFilter : [];
}

// EXPRESS CONFIGURATION
const app = express();

// Configure Express
app.set('port', process.env.PORT || 3000);
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Middleware for logging request data (optional)
function logData(req, res, next) {
    // Limit body size in logs to prevent console flooding
    const bodyString = JSON.stringify(req.body);
    const truncatedBody = bodyString.length > 1000 
        ? bodyString.substring(0, 1000) + '... [truncated]' 
        : bodyString;
    
    // console.log("method:", req.method, "url:", req.url);
    // console.log("body:", truncatedBody);
    // console.log("headers:", req.headers);
    next();
}

if (!isProduction) {
    app.use(logData);
}

// Route to handle 'save' requests
app.post('/journeybuilder/save/', (req, res) => {
    // console.log('Saving activity with data:', req.body);
    res.status(200).send('Save');
});

// Route to handle 'validate' requests
app.post('/journeybuilder/validate/', (req, res) => {
    // console.log('Validating activity with data:', req.body);
    res.status(200).send('Validate');
});

// Route to handle 'publish' requests
app.post('/journeybuilder/publish/', (req, res) => {
    // console.log('Publishing journey with data:', req.body);
    res.status(200).send('Publish');
});

let accumulatedRecords = [];
let processTimeout;  // For handling remaining records after a delay

const { v4: uuidv4 } = require('uuid');
const AsyncLock = require('async-lock');

const lock = new AsyncLock();

// Set up a cron job to process records every 20 seconds
// Using node-cron's extended syntax with seconds (first parameter)
cron.schedule('*/20 * * * * *', () => {
    if (accumulatedRecords.length > 0) {
        // console.log(`Cron job running: Processing ${accumulatedRecords.length} accumulated records`);
        
        // Check if lock is already acquired before processing
        if (!lock.isBusy('accumulatedRecords')) {
            doProcessRecords();
        } else {
            // console.log('Previous processing job still running, skipping this cycle');
        }
    }
});

// MAIN PROCESSING: group by templateField_journeyId, batch of 20, handle quota wait if needed
async function doProcessRecords() {
    await lock.acquire('accumulatedRecords', async () => {
        // Group records by templateField and journeyId
        const groupedRecords = {};
        for (const record of accumulatedRecords) {
            const key = `${record.templateField}_${record.journeyId}`;
            if (!groupedRecords[key]) {
                groupedRecords[key] = [];
            }
            groupedRecords[key].push(record);
        }

        // Clear the global array now that we have them in local groups
        accumulatedRecords = [];

        // Process each group with rate limiting
        for (const [key, records] of Object.entries(groupedRecords)) {
            const [groupTemplateField, groupJourneyId] = key.split('_');
            let batch = [];
            let batchCount = 0;
            const batchStartTime = Date.now();
            // console.log(groupedRecords);
            // Process in batches of 20
            while (records.length > 0) {
                batch = records.splice(0, 20);
                batchCount++;

                // Rate limiting: 5 batches per second
                if (batchCount % 5 === 0) {
                    const elapsedTime = Date.now() - batchStartTime;
                    if (elapsedTime < 1000) {
                        await new Promise(resolve => setTimeout(resolve, 1000 - elapsedTime));
                    }
                }

                await processBatch(
                    batch,
                    groupTemplateField,
                    groupJourneyId
                );
            }
        }
    });
}

// Batch processing: sends data to Sprinklr in a single call, with max 3 retries
async function processBatch(batch, templateField, journeyId) {
    // console.log(`Processing batch of ${batch.length} records for template "${templateField}" and journey "${journeyId}".`);

    // Declare variables at the beginning to avoid reference errors
    let templateName = 'Unknown';
    let journeyName = 'Unknown';
    let placeholders = [];

    // Extract journey name from the first record in the batch
    const firstRecord = batch[0];
    if (firstRecord && firstRecord.templateName && firstRecord.sprinklrJourneyName) {
        templateName = firstRecord.templateName;
        journeyName = firstRecord.sprinklrJourneyName;
    }

    // Step 1: Fetch template details to get the name and placeholders
    try {
        const token = await getSprinklrToken();
        const templateData = await fetchTemplateByIdFromSprinklr(templateField, token);
        // console.log('Full templateData response:', JSON.stringify(templateData, null, 2));
        if (templateData && templateData.data && templateData.data.results.length > 0) {
            const template = templateData.data.results[0];
            templateName = template.name; // Get the template name
            if (template.templateAsset && template.templateAsset.attachment && template.templateAsset.attachment.placeholders) {
                placeholders = template.templateAsset.attachment.placeholders;
                // console.log(placeholders);
            }
        } else {
            // console.log(`Could not find template details for ID: ${templateField}`);
        }
    } catch (error) {
        // console.log(`Error fetching template details for ID ${templateField}:`, error.message);
        // Continue processing with a default template name, or you could return early
    }

    // Step 2: Log the batch processing with the fetched template name
    console.log(`Processing batch of ${batch.length} records for template "${templateName}" (${templateField}) and journey "${journeyId}".`);

    const validRecords = batch.filter(deRow => deRow.phoneData);
    if (validRecords.length !== batch.length) {
        // console.log(`Filtered out ${batch.length - validRecords.length} records without phoneData`);
    }

    // Step 3: Create a case-insensitive map of placeholders to ensure correct capitalization
    const placeholderMap = placeholders.reduce((acc, placeholder) => {
        if (placeholder.displayName) {
            acc[placeholder.displayName.toLowerCase()] = placeholder.displayName;
        }
        return acc;
    }, {});

    // console.log('Placeholder mapping:', placeholderMap);

    if (validRecords.length !== batch.length) {
        // console.log(`Filtered out ${batch.length - validRecords.length} records without phoneData`);
    }

    // Build payload with enhanced error handling
    const contacts = validRecords.map((deRow) => {
        try {
            // Validate deRow structure
            if (!deRow || typeof deRow !== 'object') {
                console.log('Invalid deRow structure:', deRow);
                return null;
            }

            if (!deRow.phoneData) {
                console.log('Skipping record without phoneData:', deRow);
                return null;
            }

            // Step 4: Build contextParams with proper case matching
            const contextParams = {
                ...Object.entries(deRow.dynamicData || {}).reduce((acc, [key, value]) => {
                    try {
                        // Find the correct placeholder name using case-insensitive matching
                        const lowerKey = key.toLowerCase();
                        const correctPlaceholderName = placeholderMap[lowerKey] || key;
                        
                        // console.log(`Mapping "${key}" to "${correctPlaceholderName}" with value "${value}"`);
                        acc[correctPlaceholderName] = value || `Missing value for ${correctPlaceholderName}`;
                        return acc;
                    } catch (error) {
                        console.log(`Error processing dynamic data key "${key}":`, error.message);
                        return acc;
                    }
                }, {})
            };

            return {
                unifiedProfile: {
                    contact: {},
                    profiles: [
                        {
                            channelType: "WHATSAPP_BUSINESS",
                            channelId: deRow.phoneData
                        }
                    ]
                },
                contextParams
            };
        } catch (error) {
            console.log('Error processing record:', error.message, 'Record:', deRow);
            return null;
        }
    }).filter(contact => contact !== null && contact !== undefined); // More explicit filtering


    const payload = {
        journeyId: journeyId,
        globalContextParams: {IGNORE_DEDUP: true, var1: templateField },
        journeyProfiles: contacts
    };
    // console.log('***Payload:', payload);

    const maxRetries = 3;
    let retryCount = 0;
    let retryDelay = 1000; // Start with 1 second delay

    while (retryCount < maxRetries) {
        try {
            const token = await getSprinklrToken();

            const response = await handleSprinklrRequest(() => {
              // console.log('Original Payload:', JSON.stringify(payload).substring(0, MAX_LENGTH));
              return axios.post(
                'https://api3.sprinklr.com/api/v2/marketing-journey/bulk-trigger',
                payload,
                {
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'workspace_id': '9264'
                  }
                }
              );
            });
            

            totalProcessedRecords += validRecords.length;

            // Updated tracking to use templateName and journeyName
            if (validRecords.length > 0 && templateName && journeyName) {
                const key = `${templateName}_${journeyName}`;
                processedByTemplateAndJourneyCounts[key] = (processedByTemplateAndJourneyCounts[key] || 0) + validRecords.length;
                const timestampedKey = `${key}_${new Date().toISOString()}`;
            
                // Initialize as array if it doesn't exist, then push new response.data
                if (!Array.isArray(Sprinklr[key])) {
                    Sprinklr[key] = [];
                }
                Sprinklr[key].push({
                    timestamp: new Date().toISOString(),
                    data: response?.data
                });
            
                // You can still keep the timestampedKey if you want individual entries as well
                Sprinklr[timestampedKey] = response?.data;
            }

            

            return { success: true };
        } catch (error) {
            retryCount++;

            const errorMessage = error?.message || 'Unknown error';
            const errorResponseData = JSON.stringify(error?.response?.data || {}).substring(0, MAX_LENGTH);

            // Log to console for debugging (400, etc.)
            console.log(`Error sending batch to Sprinklr (attempt ${retryCount}/${maxRetries}): ${errorMessage}`);
            console.log('Original Payload:', JSON.stringify(payload).substring(0, MAX_LENGTH));
            console.log('Sprinklr Error Response:', errorResponseData);

            if (retryCount >= maxRetries) {
                try {
                    const sfmcPayload = {
                        externalKey: process.env.SFMC_DEKEY_FAILURE,
                        items: [
                            {
                                request: JSON.stringify(payload).substring(0, MAX_LENGTH),
                                error: errorMessage.substring(0, MAX_LENGTH),
                                timestamp: new Date().toISOString(),
                                journeyId,
                                templateId: templateField,
                                batchSize: batch.length,
                                errorDetails: errorResponseData,
                                retryAttempts: retryCount
                            }
                        ]
                    };

                    const sfmcToken = await getSfmcToken(process.env.DEFAULT_SFMC_MID);
                    const sfmcUrl = `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com/data/v1/async/dataextensions/key:${sfmcPayload.externalKey}/rows`;

                    await axios.post(sfmcUrl, { items: sfmcPayload.items }, {
                        headers: {
                            'Authorization': `Bearer ${sfmcToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                } catch (sfmcError) {
                    console.log('Error logging failed batch to SFMC:', sfmcError.message || sfmcError);
                }

                return { success: false, error: errorMessage };
            }

            retryDelay *= 2;
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

// Main /journeybuilder/execute route logic
app.post('/journeybuilder/execute/', async (req, res) => {
    // console.log('Request Body:', req.body);  // Logging the entire request body
    
    // Increment the received records counter
    totalReceivedRecords++;

    try {
        const inArguments = req.body.inArguments || [];
        const phoneNumberField = inArguments.find(arg => arg.phoneNumberField)?.phoneNumberField;
        const templateField = inArguments.find(arg => arg.templateField)?.templateField;
        const journeyId = inArguments.find(arg => arg.journeyField)?.journeyField;
        const templateName = inArguments.find(arg => arg.templateName)?.templateName;
        const sprinklrJourneyName = inArguments.find(arg => arg.sprinklrJourneyName)?.sprinklrJourneyName;
        const dynamicFields = inArguments.find(arg => arg.dynamicFields)?.dynamicFields || {};
        const phoneData = inArguments.find(arg => arg.PhoneData)?.PhoneData;
        const dynamicData = inArguments.find(arg => arg.DynamicData)?.DynamicData || {};

        if (templateName && sprinklrJourneyName) {
            const key = `${templateName}_${sprinklrJourneyName}`;
            receivedByTemplateAndJourneyCounts[key] = (receivedByTemplateAndJourneyCounts[key] || 0) + 1;
        }

        // Update templateField counts
        if (templateField) {
            templateFieldCounts[templateName] = (templateFieldCounts[templateName] || 0) + 1;
        }

        // Update journeyId counts
        if (sprinklrJourneyName) {
            journeyIdCounts[sprinklrJourneyName] = (journeyIdCounts[sprinklrJourneyName] || 0) + 1;
        }
        
        // Count records received without a phone number
        if (!phoneNumberField || !phoneData) {
            totalNoPhoneNumberRecords++;
        }

        // Accumulate each record
        accumulatedRecords.push({
            phoneData: phoneData,
            dynamicData: dynamicData,
            templateField: templateField,
            journeyId: journeyId,
            dynamicFields: dynamicFields,
            templateName: templateName,
            sprinklrJourneyName: sprinklrJourneyName,
            id: uuidv4() // Ensure each record has a unique ID
        });

        // console.log(accumulatedRecords);
        // Always respond immediately to the incoming request
        res.status(200).json({ status: 'success', message: 'Data received successfully' });

        // No need to call scheduleProcessing() as we're using a cron job now

    } catch (error) {
        // console.log('Error executing journey:', error.message);
        res.status(500).json({ error: 'Error processing journey execution' });
    }
});

// Quota check: parse Sprinklr headers to see if we can keep making calls
function checkSprinklrQuota(headers) {
    const quotaAlloted = parseInt(headers['x-packagekey-quota-alloted']) || 1000;
    const quotaCurrent = parseInt(headers['x-packagekey-quota-current']) || 0;
    const qpsAlloted = parseInt(headers['x-packagekey-qps-alloted']) || 10;
    const qpsCurrent = parseInt(headers['x-packagekey-qps-current']) || 0;
    const reservedQuota = 150;
    const resetTime = new Date(headers['x-plan-quota-reset'] || Date.now() + 60 * 60 * 1000);
    const remainingQuota = quotaAlloted - quotaCurrent - reservedQuota;
    const remainingQps = qpsAlloted - qpsCurrent;
    const canMakeCalls = remainingQuota > 0 && remainingQps > 0;

    return { canMakeCalls, resetTime };
}

// Delays until the given time
function waitUntil(time) {
    return new Promise(resolve => {
        const now = new Date();
        const delay = time.getTime() - now.getTime();
        setTimeout(resolve, Math.max(0, delay));
    });
}

app.post('/sprinklr/journeys', async (req, res) => {
    const maxRetries = 3;
    const retryDelay = 1000; // Exponential backoff delay

    try {
        const { mid } = req.body;
        if (!mid) {
            return res.status(400).json({
                error: 'MID is required',
                details: 'No MID provided in request body'
            });
        }

        const filters = getFiltersForMID(mid) || []; // Retrieve filters for the provided MID
        const requestData = {
            sorts: [{ key: "createdAt", order: "DESC" }],
            page: { size: 100 },
            filters: { filterType: "IN", field: "tags", values: filters }
        };

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const token = await getSprinklrToken();
                if (!token) {
                    // console.log('Token is empty or invalid');
                }

                const response = await axios.post(
                    'https://api3.sprinklr.com/api/v2/marketing-journey/search',
                    requestData,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'workspace_id': '9264'
                        }
                    }
                );

                const journeys = response.data.data.data;
                // console.log(journeys);
                if (!journeys || !Array.isArray(journeys)) {
                    console.warn(`Invalid response on attempt ${attempt}`);
                    if (attempt === maxRetries) {
                        return res.status(502).json({
                            error: 'Bad Gateway',
                            details: 'Invalid response from Sprinklr API'
                        });
                    }
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    continue;
                }

                if (journeys.length === 0) {
                    return res.status(204).json({
                        message: 'No journeys found for the provided filters'
                    });
                }

                return res.status(200).json({ data: journeys });
            } catch (error) {
                // console.log(`Attempt ${attempt} failed:`, error.message);

                if (attempt === maxRetries) {
                    return res.status(500).json({
                        error: 'Failed to load journeys after retries',
                        details: error.message
                    });
                }

                // Handle token renewal on authentication errors
                if (error.response && error.response.status === 401) {
                    try {
                        await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                            headers: {
                                'x-api-key': process.env.APP_API_KEY
                            }
                        });
                    } catch (tokenError) {
                        // console.log('Error renewing token:', tokenError.message);
                    }
                }

                // Retry after delay
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }

        // console.log('Max retries reached without successful response');
    } catch (error) {
        // console.log('All retry attempts failed:', error.message);
        res.status(500).json({
            error: 'Failed to load journeys',
            details: error.message
        });
    }
});

// Endpoint to fetch journey details 
app.get('/sfmcjourney/:journeyId', async (req, res) => {
    const journeyId = req.params.journeyId;
    const sfmcMID = req.headers['x-sfmc-mid'];
    try {
        const token = await getSfmcToken(sfmcMID);
        const journeyUrl = `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com/interaction/v1/interactions/${journeyId}`;
        const journeyData = await fetchDataFromSfmc(journeyUrl, token);

        const eventDefinitionKey = journeyData.triggers[0].metaData.eventDefinitionKey;
        const eventDefinitionUrl = `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com/interaction/v1/eventDefinitions/key:${eventDefinitionKey}`;
        const eventDefinitionData = await fetchDataFromSfmc(eventDefinitionUrl, token);

        const dataExtensionId = eventDefinitionData.dataExtensionId;
        const dataExtensionUrl = `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com/data/v1/customobjectdata/${dataExtensionId}/rowset?$top=1`;
        const dataExtensionData = await fetchDataFromSfmc(dataExtensionUrl, token);

        const consolidatedData = {
            journey: journeyData,
            eventDefinition: eventDefinitionData,
            dataExtension: dataExtensionData
        };

        res.json(consolidatedData);
    } catch (error) {
        if (error.response && error.response.status === 401) {
            // console.log('SFMC: 401 Unauthorized - retrying with a new token...');
            const sfmcMID = req.headers['x-sfmc-mid'];
            const newToken = await getSfmcToken(sfmcMID); // Retry with a new token
            return app.get(`/sfmcjourney/${journeyId}`, async (req, res) => {
                const journeyData = await fetchDataFromSfmc(journeyUrl, newToken);
                const eventDefinitionData = await fetchDataFromSfmc(eventDefinitionUrl, newToken);
                const dataExtensionData = await fetchDataFromSfmc(dataExtensionUrl, newToken);

                const consolidatedData = {
                    journey: journeyData,
                    eventDefinition: eventDefinitionData,
                    dataExtension: dataExtensionData
                };

                res.json(consolidatedData);
            });
        } else {
            // console.log('Error fetching journey details:', error.message || error);
            res.status(500).json({ error: 'Error fetching journey details' });
        }
    }
});

// Endpoint to fetch data extension fields
app.get('/data-extension-fields', async (req, res) => {
    try {
        const sfmcMID = req.headers['x-sfmc-mid'];
        // console.log("***sfmcMID***01: ", sfmcMID);
        const token = await getSfmcToken(sfmcMID); // Function to get the SFMC token
        const customObjectKey = req.query.customObjectKey; // Get the custom object key from the query
        const url = `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com/data/v1/customobjects/${customObjectKey}/fields`; // Adjusted URL for the API endpoint

        // Fetch the data extension fields from SFMC
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            // console.log(`Network response was not ok: ${response.statusText}`);
        }

        const data = await response.json(); // Parse the response to JSON
        // console.log('Data Extension Fields:', data);

        if (data && data.fields && data.fields.length > 0) {
            const fields = data.fields.map(field => field.name); // Extract the field names from the response
            res.json({ fields });
        } else {
            res.status(404).send({ error: 'No fields found in the Data Extension' });
        }
    } catch (error) {
        // console.log('Failed to load data extension fields:', error);
        res.status(500).send({ error: 'Failed to load data extension fields' });
    }
});

app.get('/templates', async (req, res) => {
    const maxRetries = 3;
    const retryDelay = 1000;

    try {
        const sfmcMID = req.headers['x-sfmc-mid'];
        if (!sfmcMID) {
            return res.status(400).json({
                error: 'Bad Request',
                details: 'MID is required in headers'
            });
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let token = await getSprinklrToken();
                const data = await fetchTemplatesFromSprinklr(token, sfmcMID);

                if (data && data.data && data.data.results) {
                    const templates = data.data.results.map(item => ({
                        id: item.id,
                        name: item.name
                    }));
                    return res.json({ templates });
                }

                // console.log(`Attempt ${attempt}: Invalid response structure`);

                if (attempt === maxRetries) {
                    return res.status(502).json({
                        error: 'Bad Gateway',
                        details: 'Invalid response structure from Sprinklr API'
                    });
                }

                // Get new token and retry
                await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                    headers: {
                        'x-api-key': process.env.APP_API_KEY
                    }
                });

                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                continue;
            } catch (error) {
                // console.log(`Attempt ${attempt} failed:`, error.message);


                // Get new token and retry for any error
                try {
                    await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                        headers: {
                            'x-api-key': process.env.APP_API_KEY
                        }
                    });
                } catch (tokenError) {
                    console.log('Error getting new token:', tokenError.message);
                }

                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }

        console.log('Max retries reached without successful response');
    } catch (error) {
        console.log('All retry attempts failed:', error);
        res.status(500).json({
            error: 'Failed to fetch templates',
            details: error.message,
            attemptsMade: maxRetries
        });
    }
});

app.get('/template/:id', async (req, res) => {
    const templateId = req.params.id;
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second delay between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let token = await getSprinklrToken();
            const data = await fetchTemplateByIdFromSprinklr(templateId, token);

            if (data.data.results.length > 0) {
                const template = data.data.results[0];
                let message = template.templateAsset.attachment.message;

                // Map placeholders to their display names
                const placeholders = template.templateAsset.attachment.placeholders;
                placeholders.forEach((placeholder, index) => {
                    const placeholderNumber = `{{${index + 1}}}`;
                    const displayName = `{{${placeholder.displayName}}}`;
                    message = message.replace(placeholderNumber, displayName);
                });

                return res.json({ message });
            } else {
                return res.status(404).send('Template not found');
            }
        } catch (error) {
            console.log(`Attempt ${attempt} failed:`, error.message);

            if (attempt === maxRetries) {
                console.log('Max retries reached. Sending error response.');
                return res.status(500).json({
                    error: 'Error fetching template from Sprinklr API',
                    details: error.message
                });
            }

            if (error.response && error.response.status === 401) {
                // Force new token generation for next attempt
                try {
                    await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                        headers: {
                            'x-api-key': process.env.APP_API_KEY
                        }
                    });
                } catch (tokenError) {
                    console.log('Error getting new token:', tokenError.message);
                }
            }

            // Wait before next retry
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
});

app.get('/template/:id/placeholders', async (req, res) => {
    const templateId = req.params.id;
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second delay between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let token = await getSprinklrToken();
            const data = await fetchTemplateByIdFromSprinklr(templateId, token);

            if (data.data.results.length > 0) {
                const template = data.data.results[0];
                const displayNames = [];

                if (template.templateAsset.attachment && template.templateAsset.attachment.placeholders) {
                    template.templateAsset.attachment.placeholders.forEach(placeholder => {
                        if (placeholder.displayName) {
                            displayNames.push(placeholder.displayName);
                        }
                    });
                }

                return res.json({ displayNames });
            } else {
                return res.status(404).json({
                    error: 'Template not found',
                    details: 'No results returned from Sprinklr API'
                });
            }
        } catch (error) {
            console.log(`Attempt ${attempt} failed:`, error.message);

            if (attempt === maxRetries) {
                return res.status(500).json({
                    error: 'Error fetching template placeholders',
                    details: error.message
                });
            }

            if (error.response && error.response.status === 401) {
                try {
                    await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                        headers: {
                            'x-api-key': process.env.APP_API_KEY
                        }
                    });
                } catch (tokenError) {
                    console.log('Error getting new token:', tokenError.message);
                }
            }

            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
});

// Endpoint to save configuration
app.post('/saveConfiguration', async (req, res) => {
    try {
        const configuration = req.body;
        // console.log('Saving configuration:', configuration);
        res.status(200).json({ status: 'success', message: 'Configuration saved successfully' });
    } catch (error) {
        console.log('Error saving configuration:', error);
        res.status(500).json({ status: 'error', message: 'Failed to save configuration' });
    }
});

// Start the server
http.createServer(app).listen(app.get('port'), function () {
    console.log('Express server listening on port ' + app.get('port'));
});



// Utility functions to fetch data
async function fetchDataFromSfmc(url, token) {
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        return response.data;
    } catch (error) {
        console.log(`Error fetching data from ${url}:`, error.response ? error.response.data : error.message);
    }
}


async function getSfmcToken(sfmcMID) {
    // console.log("***sfmcMID***02: ", sfmcMID);
    try {
        const response = await axios.get(`${tokenManagerUrl}/sfmc-token`, {
            headers: {
                'x-api-key': process.env.APP_API_KEY  // Include the API key in the headers
                , 'x-sfmc-mid': sfmcMID
            }
        });
        return response.data.token;
    } catch (error) {
        console.log('Error fetching SFMC token from token manager:', error.message);
    }
}

async function getSprinklrToken() {
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second delay

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                headers: {
                    'x-api-key': process.env.APP_API_KEY
                }
            });

            return response.data.access_token;
        } catch (error) {
            console.log(`Attempt ${attempt} failed: Error fetching Sprinklr token from token manager:`, error.message);

            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

// Helper function to get HSMFilter2 values
function getHSMFilter2ForMID(mid) {
    const account = accountsData.accounts.find(acc => acc.MID === mid);
    return account ? account.HSMFilter2 : [];
}

async function fetchTemplatesFromSprinklr(token, sfmcMID) {
    const maxRetries = 3;
    const retryDelay = 1000;

    const hsmFilters = getHSMFiltersForMID(sfmcMID);
    const filtersArray = Array.isArray(hsmFilters) ? hsmFilters : [];

    if (filtersArray.length === 0) {
        return { data: { results: [] } };
    }

    const hsmFilters2 = getHSMFilter2ForMID(sfmcMID) || [];
    const filters2Array = Array.isArray(hsmFilters2) ? hsmFilters2 : [];

    const currentTimestamp = Date.now();
    const requestBody = {
        filter: {
            type: "AND",
            filters: [
                { key: "assetType", values: ["TEMPLATE_ASSET"], type: "EQUALS" },
                { key: "status", values: ["APPROVED"], type: "IN" },
                { key: "restricted", values: ["0"], type: "IN" },
                { key: "templateType", values: ["HSM"], type: "IN" },
                {
                    key: "taxonomy.partnerCustomProperties.5b8ff4c8e4b01e4fe59390f7",
                    values: filtersArray,
                    type: "IN"
                },
                {
                    key: "taxonomy.partnerCustomProperties.56fce97dab2ece41ec000006",
                    values: filters2Array,
                    type: "IN"
                },
                { key: "validity.expiryTime", type: "GT", values: [currentTimestamp] }
            ]
        },
        sorts: [{ key: "id", order: "DESC" }],
        page: { size: 100 }
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(
                'https://api3.sprinklr.com/api/v2/search/SOCIAL_ASSET',
                requestBody,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'workspace_id': '9264'
                    }
                }
            );
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 401 && attempt < maxRetries) {
                // Refresh token and retry
                try {
                    await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                        headers: { 'x-api-key': process.env.APP_API_KEY }
                    });
                } catch (tokenError) {
                    console.log('Error renewing token:', tokenError.message);
                }
            }

            console.log(`Attempt ${attempt} failed:`, error.message);

            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
    }
}


async function fetchTemplateByIdFromSprinklr(templateId, token) {
    const maxRetries = 3;
    const retryDelay = 1000;

    const requestBody = {
        filter: {
            type: "AND",
            filters: [
                { key: "assetType", values: ["TEMPLATE_ASSET"], type: "EQUALS" },
                { key: "id", values: [templateId], type: "EQUALS" }
            ]
        },
        page: { size: 1 }
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(
                'https://api3.sprinklr.com/api/v2/search/SOCIAL_ASSET',
                requestBody,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'workspace_id': '9264'
                    }
                }
            );
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 401 && attempt < maxRetries) {
                // Refresh token and retry
                try {
                    await axios.get(`${tokenManagerUrl}/sprinklr-token`, {
                        headers: { 'x-api-key': process.env.APP_API_KEY }
                    });
                } catch (tokenError) {
                    console.log('Error renewing token:', tokenError.message);
                }
            }

            console.log(`Attempt ${attempt} failed:`, error.message);

            // if (attempt === maxRetries) {
            //     throw error;
            // }

            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
    }
}

async function handleSprinklrRequest(requestFn) {
    let response;
    try {
        response = await requestFn();
        return response;
    } catch (error) {
        console.log(error.status);
        
        // Return error payload wrapped in success: false
        return error.response;
    }
}

app.get('/processed-count', (req, res) => {
    res.status(200).json({
        totalReceivedRecords, // total number of records received
        totalProcessedRecords, // total number of records processed
        recordsOnHold: accumulatedRecords.length, // number of records currently on hold
        noPhoneNumber: totalNoPhoneNumberRecords, // number of records without a phone number
        countsByTemplateField: templateFieldCounts, // New
        countsByJourneyId: journeyIdCounts,        // New
        // ADD THESE LINES FOR DISPLAY
        receivedByTemplateAndJourney: receivedByTemplateAndJourneyCounts,
        processedByTemplateAndJourney: processedByTemplateAndJourneyCounts,
        Sprinklr: Sprinklr
    });
});
