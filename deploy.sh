#!/bin/bash

# ============================================================================
# Databricks Contracts App - Deploy Script
# Based on Databricks Apps best practices for React/Next.js apps
# ============================================================================

set -e  # Exit on error

# Configuration
APP_FOLDER_IN_WORKSPACE=${1:-"/Workspace/Users/fabio.goncalves@databricks.com/databricks-contracts-app"}
LAKEHOUSE_APP_NAME=${2:-"databricks-contracts-app"}
WORKSPACE_URL="https://e2-demo-field-eng.cloud.databricks.com"

echo "🚀 Databricks Contracts App - Deployment Starting"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 App Name: $LAKEHOUSE_APP_NAME"
echo "📂 Workspace Path: $APP_FOLDER_IN_WORKSPACE"
echo "🌐 Workspace URL: $WORKSPACE_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ============================================================================
# Step 1: Build Frontend (Next.js → Static files)
# ============================================================================

echo ""
echo "📦 Step 1/4: Building Next.js frontend..."
echo "────────────────────────────────────────────────────────────────────────────────"

(
  cd frontend
  echo "  → Installing dependencies..."
  npm ci --quiet
  
  echo "  → Building static export..."
  npm run build
  
  if [ ! -d "out" ]; then
    echo "❌ ERROR: Next.js build failed - 'out' directory not found"
    exit 1
  fi
  
  echo "  ✅ Frontend build complete: $(du -sh out | cut -f1)"
) &

FRONTEND_PID=$!

# ============================================================================
# Step 2: Prepare Backend
# ============================================================================

echo ""
echo "🐍 Step 2/4: Preparing FastAPI backend..."
echo "────────────────────────────────────────────────────────────────────────────────"

(
  cd backend
  mkdir -p build
  
  echo "  → Copying backend files..."
  # Copy all files except hidden, local configs, and build artifacts
  find . -mindepth 1 -maxdepth 1 \
    -not -name '.*' \
    -not -name 'local_conf*' \
    -not -name 'build' \
    -not -name '__pycache__' \
    -not -name '*.pyc' \
    -exec cp -r {} build/ \;
  
  echo "  ✅ Backend prepared: $(du -sh build | cut -f1)"
) &

BACKEND_PID=$!

# Wait for both builds to complete
wait $FRONTEND_PID
wait $BACKEND_PID

# ============================================================================
# Step 3: Upload to Databricks Workspace
# ============================================================================

echo ""
echo "☁️  Step 3/4: Uploading to Databricks Workspace..."
echo "────────────────────────────────────────────────────────────────────────────────"

# Upload frontend static files
echo "  → Uploading frontend (static files)..."
databricks workspace import-dir \
  frontend/out \
  "$APP_FOLDER_IN_WORKSPACE/static" \
  --overwrite

echo "  ✅ Frontend uploaded to: $APP_FOLDER_IN_WORKSPACE/static"

# Upload backend files
echo "  → Uploading backend (FastAPI)..."
databricks workspace import-dir \
  backend/build \
  "$APP_FOLDER_IN_WORKSPACE" \
  --overwrite

echo "  ✅ Backend uploaded to: $APP_FOLDER_IN_WORKSPACE"

# Cleanup
echo "  → Cleaning up build artifacts..."
rm -rf backend/build

# ============================================================================
# Step 4: Deploy Databricks App
# ============================================================================

echo ""
echo "🚀 Step 4/4: Deploying Databricks App..."
echo "────────────────────────────────────────────────────────────────────────────────"

databricks apps deploy \
  "$LAKEHOUSE_APP_NAME" \
  --source-code-path "$APP_FOLDER_IN_WORKSPACE"

# ============================================================================
# Deployment Complete
# ============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Deployment Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 App URL:"
echo "   $WORKSPACE_URL/apps/$LAKEHOUSE_APP_NAME"
echo ""
echo "📊 Logs:"
echo "   $WORKSPACE_URL/apps/$LAKEHOUSE_APP_NAME/logz"
echo ""
echo "📁 Workspace Files:"
echo "   $WORKSPACE_URL/workspace$APP_FOLDER_IN_WORKSPACE"
echo ""
echo "🔍 Check app status:"
echo "   databricks apps get $LAKEHOUSE_APP_NAME"
echo ""
