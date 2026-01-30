# Changelog - Databricks Contracts App

All notable changes to this project will be documented in this file.

## [2.3.0] - 2026-01-30 - **Auto Process with Background Jobs**

### Features
- **Background Job Processing**: Auto process now runs in background with polling to avoid HTTP 502 gateway timeouts
- **Real-time Progress**: UI updates in real-time with backend status (step, message, progress, files, tables)
- **Dynamic Labels**: Step labels change based on completion status (e.g., "Gerando perguntas" → "Perguntas geradas")
- **Full Table Names**: Display complete catalog.schema.table names instead of just table names
- **Expandable Evaluation Results**: Results shown in collapsible section with chevron toggle
- **Strategy Evaluation Info**: Shows chunks count and temp table names during processing

### Improvements
- Removed star emoji from Structural strategy labels
- Changed "ch" to "chunks" for clarity
- Added `useRef` for synchronous step tracking to fix timing issues
- Improved `formatTime` to handle negative values gracefully

### Backend
- New endpoint `/api/process/auto/start` - starts background job, returns jobId
- New endpoint `/api/process/auto/status/{jobId}` - returns job status for polling
- Background task updates job status in real-time with evaluation results, tables, and best strategy
- Global `auto_process_jobs` dictionary stores job state

### Bug Fixes
- Fixed negative time display (-1:-12) by using refs for step tracking
- Fixed step times not showing by removing conflicting progress simulation

---

## [2.2.0] - 2026-01-21 - **MÓDULO 1 COMPLETO** ✅

### 🎉 Módulo 1: Importação de Documentos - CONCLUÍDO

Este módulo implementa a funcionalidade completa de importação de arquivos PDF para o Databricks Unity Catalog Volume com interface profissional seguindo as diretrizes de design da Databricks.

### ✨ Features Implementadas

#### Upload de Arquivos
- ✅ Drag & drop de arquivos PDF
- ✅ Seleção múltipla de arquivos
- ✅ Validação de tipo de arquivo (apenas PDF)
- ✅ Preview de arquivos selecionados
- ✅ Detecção de arquivos duplicados na lista
- ✅ Remoção individual de arquivos da lista

#### Gerenciamento de Conflitos
- ✅ Detecção automática de arquivos existentes no volume
- ✅ Modal de confirmação para sobrescrever
- ✅ Opções de sobrescrita:
  - Sobrescrever todos
  - Sobrescrever apenas este
  - Pular este arquivo
  - **Cancelar importação completa** (NEW!)

#### Progress & Feedback
- ✅ Indicadores de progresso por arquivo
- ✅ Estados visuais: pending, uploading, success, error, skipped, ignored
- ✅ Navegação automática entre páginas durante upload
- ✅ Toast notifications com duração configurável
- ✅ Mensagem de resumo ao final do upload

#### Paginação
- ✅ Paginação de 5 arquivos por página
- ✅ Controles de navegação (anterior/próximo)
- ✅ Indicador de página atual
- ✅ Botões sempre visíveis independente da página

#### Status de Arquivos
- ✅ **Pending**: Aguardando upload
- ✅ **Uploading**: Em progresso (com spinner)
- ✅ **Success**: Upload completo
- ✅ **Error**: Falha no upload (com mensagem)
- ✅ **Skipped**: Arquivo pulado pelo usuário
- ✅ **Ignored**: Arquivo ignorado (movido ao final da lista)

### 🏗️ Arquitetura

#### Frontend
- **Framework**: Next.js 16 (Static Export)
- **Runtime**: React 19
- **Styling**: Tailwind CSS v4 + Databricks Design System
- **Icons**: Lucide React
- **Notifications**: Sonner (Toast)
- **Typography**: DM Sans (UI) + DM Mono (code)

#### Backend
- **Framework**: FastAPI
- **Server**: Uvicorn
- **HTTP Client**: httpx (async)
- **Authentication**: OBO (On-Behalf-Of) + Service Principal fallback
- **File Upload**: Databricks Workspace Files API

#### Databricks Integration
- **Storage**: Unity Catalog Volumes
- **Authentication**: Service Principal + OBO
- **Deployment**: Databricks Apps (Python runtime)
- **Logging**: Comprehensive structured logging

### 🎨 Design System

#### Cores Databricks
- **Primary**: #FF3621 (Databricks Red)
- **Success**: #00A972 (Databricks Teal)
- **Dark**: #1B1B1D (Databricks Dark)
- **Neutral**: Tailwind gray scale

#### Componentes
- Botões com estados (hover, disabled, loading)
- Cards com bordas suaves e sombras sutis
- Modal com overlay semi-transparente
- Tabela com hover states e transições
- Upload area com drag & drop visual feedback

### 🔒 Segurança

- ✅ Tokens não hardcoded no código
- ✅ `.env.local` no `.gitignore`
- ✅ OBO authentication para respeitar permissões do usuário
- ✅ Validação de tipo de arquivo no cliente e servidor
- ✅ Secret scanning no pre-commit hook

### 🐛 Bugs Corrigidos

- ✅ HTTP 204 reconhecido como sucesso (uploads estavam falhando)
- ✅ NaN MB nos tamanhos de arquivo
- ✅ "Sobrescrever todos" não estava funcionando
- ✅ Nome de arquivo estourando no modal
- ✅ Checkmark duplicado nas toast messages
- ✅ Arquivos pulados ficavam sem status

### 📚 Documentação

- ✅ README.md completo com setup e troubleshooting
- ✅ `.cursor/rules/docs.mdc` - Documentação técnica detalhada
- ✅ `.cursor/rules/development-guidelines.mdc` - Guia de desenvolvimento
- ✅ Comentários inline no código
- ✅ Component library documented

### 🚀 Deployment

- ✅ Script automatizado `deploy.sh`
- ✅ Build e upload paralelos
- ✅ Verificação de erros
- ✅ Output colorido e informativo
- ✅ URLs geradas automaticamente

### 📊 Estatísticas do Módulo 1

```
📦 Commits: 18
🏷️ Tags: v1.0.0 → v2.2.0
📝 Arquivos: ~50 arquivos criados/modificados
🎨 Componentes: 5 principais (TopNav, UploadArea, FileList, Modal, Toast)
🔧 APIs: 2 endpoints (/api/upload, /health)
📖 Documentação: 1500+ linhas
```

## Versões Anteriores

### [2.1.2] - 2026-01-20
**Security & Cleanup**
- Removido update-token.sh (token hardcoded)
- Removido get-logs.sh (helper desnecessário)
- Adicionada seção de logs no README

### [2.1.1] - 2026-01-20
**Configuration Visibility**
- Restaurado app.yaml no project root
- Melhorada visibilidade da configuração

### [2.1.0] - 2026-01-20
**Skipped Files Feature**
- Status "Ignored" para arquivos pulados
- Arquivos ignorados movidos ao final da lista
- Lógica atualizada no botão "Concluir"

### [2.0.0-fastapi] - 2026-01-20
**Migração para FastAPI**
- Migrado de Next.js SSR para FastAPI + Static Next.js
- Seguindo recomendações oficiais da Databricks
- Arquitetura mais estável e documentada

### [1.0.0] - 2026-01-19
**Versão Inicial**
- Estrutura básica do projeto
- Navegação e layout inicial
- Componentes de UI base

---

## 🎯 Próximos Passos (Módulo 2)

O Módulo 1 está completo e em produção. Próximos desenvolvimentos manterão toda a funcionalidade existente e adicionarão novas capacidades.

**Status**: ✅ Módulo 1 finalizado | 🚧 Módulo 2 em planejamento
