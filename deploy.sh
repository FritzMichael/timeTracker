#!/bin/bash
# deploy.sh - Run this on your VPS to deploy/update the app
# Usage: ./deploy.sh

set -e

echo "🚀 Deploying Time Tracker..."

# Pull latest changes
echo "📥 Pulling latest code..."
git pull origin main

# Rebuild and restart containers
echo "🔨 Rebuilding containers..."
docker-compose -f docker-compose.prod.yml build --no-cache

echo "🔄 Restarting services..."
docker-compose -f docker-compose.prod.yml up -d

# Cleanup old images
echo "🧹 Cleaning up old images..."
docker image prune -f

echo "✅ Deployment complete!"
echo "🌐 App running at http://$(hostname -I | awk '{print $1}'):3000"
