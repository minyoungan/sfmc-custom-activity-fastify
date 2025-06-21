'use strict';

const fastify = require('fastify')({ 
  logger: true,
  trustProxy: true
});
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const AsyncLock = require('async-lock');

// Replaced 'node-cron' with 'fastify-cron'.
const fastifyCron = require('fastify-cron');

// Load environment variables
require('dotenv').config();

// Register static files plugin - IMPORTANT: This serves ALL subfolders
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  wildcard: true, // This is key for serving subfolders
  index: ['index.html'], // Serve index.html for directories
  list: false, // Disable directory listing for security
  dotfiles: 'ignore' // Ignore hidden files
});

// Root route - serve index.html from public folder
fastify.get('/', async (request, reply) => {
  return reply.sendFile('index.html');
});

// Health check route (moved to different path)
fastify.get('/health', async (request, reply) => {
  return { 
    status: 'ok', 
    message: 'Fastify server is running',
    environment: process.env.NODE_ENV 
  };
});

// Journey Builder routes
fastify.post('/journeybuilder/save/', async (request, reply) => {
  reply.code(200).send('Save');
});

fastify.post('/journeybuilder/validate/', async (request, reply) => {
  reply.code(200).send('Validate');
});

fastify.post('/journeybuilder/publish/', async (request, reply) => {
  reply.code(200).send('Publish');
});

// Main execution route
fastify.post('/journeybuilder/execute/', async (request, reply) => {
  try {
    const inArguments = request.body.inArguments || [];
    const phoneData = inArguments.find(arg => arg.PhoneData)?.PhoneData;
    const templateField = inArguments.find(arg => arg.templateField)?.templateField;
    const journeyId = inArguments.find(arg => arg.journeyField)?.journeyField;

    console.log('Received execution request:', {
      phoneData,
      templateField,
      journeyId
    });

    reply.code(200).send({ 
      status: 'success', 
      message: 'Data received successfully' 
    });

  } catch (error) {
    console.error('Error processing journey execution:', error);
    reply.code(500).send({ 
      error: 'Error processing journey execution' 
    });
  }
});

// Start the server
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    const host = '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`Fastify server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
