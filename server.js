#!/usr/bin/env node

/**
 * Custom server for Databricks Apps
 * Ensures Next.js starts on the correct port (8000) and binds to 0.0.0.0
 */

const { spawn } = require('child_process');

// Databricks Apps injects PORT=8000
const port = process.env.PORT || 8000;
const hostname = '0.0.0.0';

console.log('🚀 Starting Next.js server...');
console.log(`📍 Port: ${port}`);
console.log(`📍 Hostname: ${hostname}`);
console.log(`📍 NODE_ENV: ${process.env.NODE_ENV || 'production'}`);

// Start Next.js with correct parameters
const args = ['start', '-H', hostname, '-p', port.toString()];

console.log(`🔧 Executing: next ${args.join(' ')}`);

const nextServer = spawn('next', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
    HOSTNAME: hostname,
  },
});

nextServer.on('error', (error) => {
  console.error('❌ Failed to start Next.js server:', error);
  process.exit(1);
});

nextServer.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`❌ Next.js server exited with code ${code} and signal ${signal}`);
    process.exit(code || 1);
  }
  console.log('✅ Next.js server stopped gracefully');
});

// Handle termination signals
process.on('SIGTERM', () => {
  console.log('📢 SIGTERM received, shutting down gracefully...');
  nextServer.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('📢 SIGINT received, shutting down gracefully...');
  nextServer.kill('SIGINT');
});
