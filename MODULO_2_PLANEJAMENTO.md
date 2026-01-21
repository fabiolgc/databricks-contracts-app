# 🚧 Módulo 2 - Planejamento

**Status**: 🚧 **EM PLANEJAMENTO**  
**Início Previsto**: Janeiro 2026  
**Dependências**: ✅ Módulo 1 completo

---

## 📋 Visão Geral

O **Módulo 2** focará em adicionar funcionalidades de processamento e análise dos documentos PDF importados no Módulo 1. Este módulo será desenvolvido mantendo toda a funcionalidade existente intacta.

---

## 🎯 Objetivos

Funcionalidades principais a serem desenvolvidas:

### 1. Processamento de Documentos
- [ ] Listagem de documentos no volume
- [ ] Preview/visualização de PDFs
- [ ] Extração de metadados
- [ ] Processamento em background

### 2. Chunking de Documentos
- [ ] Estratégias de chunking (por página, por tamanho, semântico)
- [ ] Configuração de parâmetros (tamanho, overlap)
- [ ] Visualização de chunks
- [ ] Storage de chunks

### 3. Integração com Databricks
- [ ] Criar/executar Databricks Jobs para processamento
- [ ] Monitoramento de status de jobs
- [ ] Logs de processamento
- [ ] Retry em caso de falhas

### 4. Interface de Gerenciamento
- [ ] Nova página "Processar Documentos"
- [ ] Seleção de documentos para processar
- [ ] Configuração de estratégias
- [ ] Dashboard de status

---

## 🏗️ Arquitetura Proposta

### Novos Componentes Frontend

```
frontend/
├── app/
│   └── (shell)/
│       ├── import/              # ✅ Módulo 1 (mantido)
│       ├── process/             # 🆕 Módulo 2
│       │   ├── page.tsx         # Lista de documentos
│       │   └── [id]/            # Detalhes/processamento
│       │       └── page.tsx
│       └── layout.tsx
└── components/
    ├── nav/                     # ✅ Existente
    ├── process/                 # 🆕 Novos componentes
    │   ├── document-list.tsx
    │   ├── chunking-config.tsx
    │   ├── job-status.tsx
    │   └── preview-chunks.tsx
    └── ui/                      # ✅ Compartilhados
```

### Novos Endpoints Backend

```python
# backend/app.py

# Listar documentos no volume
@app.get("/api/documents")
async def list_documents(...)

# Obter detalhes de um documento
@app.get("/api/documents/{filename}")
async def get_document_details(...)

# Iniciar processamento/chunking
@app.post("/api/process")
async def process_document(...)

# Obter status do job
@app.get("/api/jobs/{job_id}/status")
async def get_job_status(...)

# Listar chunks de um documento
@app.get("/api/documents/{filename}/chunks")
async def get_document_chunks(...)
```

### Integração com Databricks

```python
# Databricks Jobs API
- Criar job de processamento
- Executar job
- Monitorar status
- Obter logs

# Possíveis tabelas Delta
- contracts_metadata (info dos PDFs)
- contracts_chunks (chunks extraídos)
- contracts_processing_log (histórico)
```

---

## 🎨 Design de Interface (Rascunho)

### Nova Página: "Processar Documentos"

```
┌─────────────────────────────────────────────────────────────┐
│ [Logo] Contracts App                                        │
│ ┌────────────────┬────────────────┐                         │
│ │ Importar Docs  │ Processar Docs │ ← Nova aba             │
│ └────────────────┴────────────────┘                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📄 Documentos Importados                                   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ☐ contract_001.pdf         │ 2.5 MB │ Não processado  │ │
│  │ ☐ contract_002.pdf         │ 1.8 MB │ Processando...  │ │
│  │ ☐ contract_003.pdf         │ 3.2 MB │ ✅ Processado   │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [ Selecionar Todos ] [ Processar Selecionados ]           │
│                                                             │
│  ⚙️ Configurações de Chunking                               │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Estratégia: [Dropdown: Por página ▼]                      │
│  Tamanho: [___1000___] caracteres                          │
│  Overlap: [___200___] caracteres                           │
│                                                             │
│  [ Aplicar Configurações ]                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Dependências Adicionais

### Frontend
```json
{
  "dependencies": {
    // Possíveis novas dependências
    "@react-pdf-viewer/core": "^3.x", // Para preview de PDF
    "date-fns": "^3.x",               // Para formatação de datas
    "recharts": "^2.x"                // Para gráficos (opcional)
  }
}
```

### Backend
```txt
# requirements.txt adicionais
databricks-sdk          # SDK Python para Databricks API
pydantic                # Validação de dados (já temos)
PyPDF2                  # Leitura de PDFs
langchain               # Chunking strategies (opcional)
tiktoken                # Token counting (opcional)
```

---

## 🔄 Estratégias de Chunking

### 1. Por Página
- Cada página do PDF = 1 chunk
- Simples e direto
- Bom para documentos estruturados

### 2. Por Tamanho Fixo
- Chunks de N caracteres/tokens
- Overlap configurável
- Bom para documentos longos

### 3. Semântico (Avançado)
- Baseado em estrutura do documento
- Parágrafos, seções, capítulos
- Requer parsing mais sofisticado

---

## 🧪 Casos de Teste

- [ ] Listar documentos do volume
- [ ] Filtrar documentos por status
- [ ] Selecionar múltiplos documentos
- [ ] Configurar parâmetros de chunking
- [ ] Iniciar processamento de 1 documento
- [ ] Iniciar processamento em lote
- [ ] Monitorar progresso de job
- [ ] Visualizar chunks extraídos
- [ ] Tratar erros de processamento
- [ ] Retry de documentos com falha

---

## 📊 Métricas de Sucesso

- Processamento de PDFs em < 5 minutos (para documentos médios)
- Interface responsiva e profissional
- Feedback em tempo real do status
- 99% de documentos processados com sucesso
- Logs completos para debugging

---

## 🚀 Roadmap de Desenvolvimento

### Fase 1: Listagem e Preview (1-2 dias)
- [ ] Endpoint para listar documentos
- [ ] Componente de lista de documentos
- [ ] Preview básico de PDF
- [ ] Filtros de status

### Fase 2: Configuração de Chunking (1-2 dias)
- [ ] Interface de configuração
- [ ] Validação de parâmetros
- [ ] Salvamento de preferências

### Fase 3: Integração com Jobs (2-3 dias)
- [ ] Criação de job Databricks
- [ ] Execução e monitoramento
- [ ] Polling de status
- [ ] Tratamento de erros

### Fase 4: Visualização de Resultados (1-2 dias)
- [ ] Listagem de chunks
- [ ] Preview de chunks
- [ ] Estatísticas de processamento

### Fase 5: Testes e Refinamento (1 dia)
- [ ] Testes end-to-end
- [ ] Ajustes de UX
- [ ] Documentação

**Estimativa Total**: 6-10 dias de desenvolvimento

---

## ⚠️ Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| PDFs com formato não-padrão | Média | Alto | Validação robusta + tratamento de erros |
| Tempo de processamento longo | Alta | Médio | Jobs assíncronos + feedback de progresso |
| Limite de recursos Databricks | Baixa | Alto | Configuração adequada de clusters |
| Chunks muito grandes/pequenos | Média | Médio | Configuração ajustável + testes |

---

## 🔗 Referências

- [Databricks Jobs API](https://docs.databricks.com/api/workspace/jobs)
- [Unity Catalog Volumes](https://docs.databricks.com/data-governance/unity-catalog/volumes.html)
- [LangChain Text Splitters](https://python.langchain.com/docs/modules/data_connection/document_transformers/)
- [PyPDF2 Documentation](https://pypdf2.readthedocs.io/)

---

## 💡 Notas

- Todas as funcionalidades do Módulo 1 serão mantidas intactas
- Design consistency com Databricks guidelines
- Código modular e testável
- Documentação atualizada conforme desenvolvimento

---

**🚧 Este documento será atualizado conforme o Módulo 2 for desenvolvido 🚧**

---

*Última atualização: 21 de Janeiro de 2026*
