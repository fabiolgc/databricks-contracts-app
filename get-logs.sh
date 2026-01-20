#!/bin/bash

# Script para pegar logs do Databricks App

echo "🔍 Buscando logs do app databricks-contracts-app..."
echo ""

# Usando databricks CLI
databricks apps get databricks-contracts-app 2>&1

echo ""
echo "📊 Últimos deployments:"
databricks apps list-deployments databricks-contracts-app --output json | jq -r '.[] | select(.status.state == "SUCCEEDED") | "\(.update_time) - \(.deployment_id)"' | head -5

echo ""
echo "✅ App deployado com logging em: 2026-01-20T23:52:20Z"
echo ""
echo "⚠️  Para ver logs, acesse no UI do Databricks:"
echo "   Apps → databricks-contracts-app → Logs"
echo ""
echo "🌐 URL do app:"
echo "   https://databricks-contracts-app-1444828305810485.aws.databricksapps.com"
echo ""
