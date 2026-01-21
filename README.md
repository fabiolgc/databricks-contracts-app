# Databricks Contracts App

A React/Next.js application with FastAPI backend for managing PDF contracts, with integration to Unity Catalog, SQL Warehouse, and Databricks services.

**Architecture**: Static Next.js frontend served by FastAPI backend (following official Databricks Apps best practices).

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-green)
![Next.js](https://img.shields.io/badge/Next.js-16.1.4-black)
![React](https://img.shields.io/badge/React-19.2.3-blue)

## 🚀 Features

- ✅ **PDF Contract Upload**: Upload contracts to Unity Catalog Volumes
- ✅ **OBO Authentication**: Respects user permissions (On-Behalf-Of)
- ✅ **Conflict Resolution**: Smart handling of duplicate files
- ✅ **Real-time Progress**: Visual feedback for uploads
- ✅ **Professional UI**: Databricks design system with DM Sans typography
- 🔄 **Chunking** (Planned): Process documents using Databricks Jobs
- 🔍 **Vector Search** (Planned): AI-powered contract search
- 🤖 **Agent Interface** (Planned): Contract analysis with AI

## 📋 Architecture

### Stack

- **Frontend**: Next.js 16 (Static Export), React 19, TypeScript
- **Backend**: FastAPI (Python) serving static files + API endpoints
- **Styling**: Tailwind CSS v4 with Databricks brand guidelines
- **Deployment**: Databricks Apps (Python runtime)
- **Database**: Databricks SQL Warehouse
- **Storage**: Unity Catalog Volumes

### How It Works

```
┌─────────────┐       ┌──────────────┐       ┌──────────────────┐
│   Browser   │──────▶│   FastAPI    │──────▶│  Unity Catalog   │
│  (Static)   │◀──────│   (Python)   │◀──────│    Volumes       │
└─────────────┘       └──────────────┘       └──────────────────┘
     HTML/JS          Serves static +              File
     assets           API endpoints              Storage
```

1. **Build**: Next.js generates static files → `/frontend/out`
2. **Deploy**: FastAPI serves static files + provides API endpoints
3. **Runtime**: Python/uvicorn on Databricks Apps (port 8000)

## 🏗️ Project Structure

```
databricks-contracts-app/
├── frontend/                   # Next.js application
│   ├── app/                   # App Router (pages)
│   │   ├── (shell)/          # Shell layout group
│   │   │   ├── import/       # Import page
│   │   │   └── layout.tsx    # Shell with TopNav
│   │   ├── assets/           # Images
│   │   ├── globals.css       # Global styles
│   │   └── layout.tsx        # Root layout
│   ├── components/           # React components
│   │   └── nav/             # Navigation
│   ├── lib/                  # Utilities
│   ├── public/               # Static assets
│   ├── package.json          # Dependencies
│   ├── next.config.ts        # Next.js config (output: 'export')
│   └── tsconfig.json         # TypeScript config
│
├── backend/                   # FastAPI backend
│   ├── app.py                # Main application
│   ├── requirements.txt      # Python dependencies
│   └── app.yaml              # Databricks Apps config
│
├── deploy.sh                  # Deployment automation
├── get-logs.sh               # Helper to view logs
└── README.md                 # This file
```

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+ and npm
- **Python** 3.9+
- **Databricks CLI** configured
- **Databricks Workspace** with:
  - Unity Catalog Volume (READ_VOLUME, WRITE_VOLUME permissions)
  - SQL Warehouse (CAN_USE permission)

### Local Development

**Frontend (Next.js):**

```bash
cd frontend
npm install
npm run dev
# Opens on http://localhost:3000
```

**Backend (FastAPI):**

```bash
cd backend
pip install -r requirements.txt

# Set environment variables
export DATABRICKS_SERVER_HOSTNAME="your-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="your-personal-access-token"
export DATABRICKS_CATALOG="your_catalog"
export DATABRICKS_SCHEMA="your_schema"
export DATABRICKS_VOLUME="your_volume"

# Run server
uvicorn app:app --reload --host 0.0.0.0 --port 8000
# Opens on http://localhost:8000
```

### Build

```bash
cd frontend
npm run build
# Generates static files in frontend/out/
```

### Deploy to Databricks

**Automated (Recommended):**

```bash
./deploy.sh
```

The script will:
1. ✅ Build Next.js frontend (static export)
2. ✅ Prepare FastAPI backend
3. ✅ Upload frontend to `/static` in workspace
4. ✅ Upload backend to workspace root
5. ✅ Deploy app via Databricks CLI
6. ✅ Show app URL and logs

**Manual:**

```bash
# 1. Build frontend
cd frontend && npm run build

# 2. Upload static files
databricks workspace import-dir \
  frontend/out \
  "/Workspace/Users/<your-email>/databricks-contracts-app/static" \
  --overwrite

# 3. Upload backend
cd backend
databricks workspace import-dir \
  . \
  "/Workspace/Users/<your-email>/databricks-contracts-app" \
  --overwrite

# 4. Deploy app
databricks apps deploy databricks-contracts-app \
  --source-code-path "/Workspace/Users/<your-email>/databricks-contracts-app"
```

## 🔧 Configuration

### Environment Variables

Configure in `backend/app.yaml`:

```yaml
env:
  - name: DATABRICKS_CATALOG
    value: "your_catalog"
  
  - name: DATABRICKS_SCHEMA
    value: "your_schema"
  
  - name: DATABRICKS_VOLUME
    value: "your_volume"
  
  - name: DATABRICKS_WAREHOUSE_ID
    value: "your_warehouse_id"
  
  - name: DATABRICKS_SERVER_HOSTNAME
    value: "your-workspace.cloud.databricks.com"
  
  - name: DATABRICKS_HTTP_PATH
    value: "/sql/1.0/warehouses/your_warehouse_id"
```

### Permissions

Grant permissions to the Service Principal (auto-created by Databricks Apps):

```sql
-- Catalog & Schema
GRANT USE CATALOG ON CATALOG your_catalog TO `service-principal-id`;
GRANT USE SCHEMA ON SCHEMA your_catalog.your_schema TO `service-principal-id`;

-- Volume
GRANT READ VOLUME ON VOLUME your_catalog.your_schema.your_volume TO `service-principal-id`;
GRANT WRITE VOLUME ON VOLUME your_catalog.your_schema.your_volume TO `service-principal-id`;

-- SQL Warehouse
GRANT CAN_USE ON SQL WAREHOUSE your_warehouse_id TO `service-principal-id`;
```

## 📚 API Endpoints

### `POST /api/upload`

Upload PDF files to Unity Catalog Volume.

**Request:**
```bash
curl -X POST "https://your-app.databricksapps.com/api/upload" \
  -F "file=@contract.pdf" \
  -F "overwrite=false"
```

**Response (Success):**
```json
{
  "success": true,
  "fileName": "contract.pdf",
  "path": "/Volumes/catalog/schema/volume/contract.pdf",
  "size": 1024000
}
```

**Response (Conflict - 409):**
```json
{
  "fileExists": true,
  "fileName": "contract.pdf",
  "path": "/Volumes/catalog/schema/volume/contract.pdf"
}
```

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-21T00:00:00Z",
  "environment": {
    "host_configured": true,
    "token_configured": true,
    "catalog": "your_catalog",
    "schema": "your_schema",
    "volume": "your_volume"
  }
}
```

## 🎨 Design System

Follows [Databricks Brand Guidelines](https://brand.databricks.com/):

- **Colors**: Databricks Red (#FF3621), Teal (#00A972), Dark (#1B1B1D)
- **Typography**: DM Sans (UI), DM Mono (code)
- **Components**: Tailwind CSS v4 with custom Databricks styling

## 🐛 Troubleshooting

### Viewing App Logs

**Option 1: Databricks UI**
1. Go to Databricks Workspace → **Apps**
2. Click on **databricks-contracts-app**
3. Navigate to **Logs** tab

**Option 2: CLI**
```bash
# Get app status and info
databricks apps get databricks-contracts-app

# List recent deployments
databricks apps list-deployments databricks-contracts-app --output json | jq -r '.[] | select(.status.state == "SUCCEEDED") | "\(.update_time) - \(.deployment_id)"' | head -5

# Access logs URL directly
open "https://your-app.databricksapps.com/logz"
```

### App Not Loading (502 Bad Gateway)

**Check:**
1. View logs: `https://your-workspace.com/apps/your-app/logz`
2. Verify `backend/app.yaml` uses `--port 8000`
3. Ensure static files uploaded to `/static` directory
4. Check Python dependencies in `requirements.txt`

**Fix:**
```bash
./deploy.sh  # Redeploy
databricks apps get databricks-contracts-app  # Check status
```

### Upload Fails (403 Forbidden)

**Check:**
- Service Principal has READ_VOLUME and WRITE_VOLUME permissions
- Volume exists: `SHOW VOLUMES IN catalog.schema;`
- Token is valid

**Fix:**
```sql
GRANT READ VOLUME ON VOLUME catalog.schema.volume TO `sp-id`;
GRANT WRITE VOLUME ON VOLUME catalog.schema.volume TO `sp-id`;
```

### Frontend Build Fails

**Check:**
```bash
cd frontend
rm -rf .next out node_modules
npm ci
npm run build
npx tsc --noEmit  # Check TypeScript errors
```

## 📖 Documentation

- **Full Documentation**: `.cursor/rules/docs.mdc`
- **Development Guidelines**: `.cursor/rules/development-guidelines.mdc`
- **Databricks Apps for React**: [Official Guide](https://databricks.com) (August 2024)

## 🤝 Contributing

1. Follow Databricks brand guidelines for all UI changes
2. Ensure TypeScript type safety
3. Add comprehensive logging for backend changes
4. Test locally before deploying
5. Update documentation

## 📝 License

Internal Databricks project.

## 🔗 Links

- **Databricks Apps**: https://docs.databricks.com/en/dev-tools/databricks-apps/
- **FastAPI**: https://fastapi.tiangolo.com/
- **Next.js**: https://nextjs.org/docs
- **Databricks Brand**: https://brand.databricks.com/

---

**Version**: 2.1.2  
**Last Updated**: January 2026  
**Architecture**: FastAPI + Static Next.js (Official Databricks Apps pattern)
