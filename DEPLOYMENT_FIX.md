# Correção de Deployment - Databricks Apps

## 🔍 Problemas Identificados

Após análise do environment do app, foram identificados **2 problemas críticos**:

### 1. ⚠️ Conflito de Porta

**Problema:**
```bash
# No app.yaml
PORT=3000  # Configurado manualmente

# No Databricks Apps (environment real)
PORT=8000  # Injetado pelo Databricks (sobrescreve o anterior)
DATABRICKS_APP_PORT=8000  # Porta que o proxy espera
```

**Impacto:** 
- Next.js tentava usar PORT=3000
- Databricks proxy esperava na PORT=8000
- Resultado: **App não carregava** (502 Bad Gateway)

**Solução Aplicada:**
```yaml
# app.yaml - ANTES ❌
env:
  - name: PORT
    value: "3000"  # Conflitava com Databricks

# app.yaml - DEPOIS ✅
# Removido PORT do app.yaml
# Databricks injeta automaticamente PORT=8000
# Next.js lê da variável de ambiente e usa 8000
```

### 2. ⚠️ Token de Autenticação Incorreto

**Problema:**
```typescript
// lib/databricks/client.ts - ANTES ❌
token: process.env.DATABRICKS_TOKEN  // Não existe no Databricks Apps!
```

**Environment real do Databricks:**
```bash
DATABRICKS_CLIENT_SECRET=***  # ✅ Este é o token correto (Service Principal)
DATABRICKS_CLIENT_ID=0b9b9963-0746-4266-8bb6-a079df8e747f
```

**Solução Aplicada:**
```typescript
// lib/databricks/client.ts - DEPOIS ✅
export function getDatabricksConfig() {
  const config = {
    host: process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST,
    // Service Principal token injetado automaticamente pelo Databricks
    token: process.env.DATABRICKS_CLIENT_SECRET || process.env.DATABRICKS_TOKEN,
    catalog: process.env.DATABRICKS_CATALOG || "fabio_goncalves",
    schema: process.env.DATABRICKS_SCHEMA || "customer_cielo",
    volume: process.env.DATABRICKS_VOLUME || "pdf",
  };

  // Validação obrigatória
  if (!config.host) {
    throw new Error("DATABRICKS_SERVER_HOSTNAME or DATABRICKS_HOST is not configured");
  }

  if (!config.token) {
    throw new Error("DATABRICKS_CLIENT_SECRET or DATABRICKS_TOKEN is not configured");
  }

  return config;
}
```

---

## ✅ Correções Implementadas

### 1. **app.yaml** - Removida configuração de PORT

**Commit:** `3ecb9ef` - fix: Configure app to use Databricks-injected PORT and CLIENT_SECRET

```diff
# app.yaml
command: ["npm", "run", "start"]

env:
  # Unity Catalog configuration
  - name: DATABRICKS_CATALOG
    value: "fabio_goncalves"
  
  - name: DATABRICKS_SCHEMA
    value: "customer_cielo"
  
  - name: DATABRICKS_VOLUME
    value: "pdf"
  
  # SQL Warehouse configuration
  - name: DATABRICKS_WAREHOUSE_ID
    value: "09231fd5489fc752"
  
  - name: DATABRICKS_SERVER_HOSTNAME
    value: "e2-demo-field-eng.cloud.databricks.com"
  
  - name: DATABRICKS_HTTP_PATH
    value: "/sql/1.0/warehouses/09231fd5489fc752"
  
- # ❌ REMOVIDO
- - name: DATABRICKS_TOKEN
-   valueFrom: DATABRICKS_ADMIN_TOKEN
-     
- - name: PORT
-   value: "3000"

+ # ✅ Databricks injeta automaticamente:
+ # - PORT=8000
+ # - DATABRICKS_CLIENT_SECRET (Service Principal token)
+ # - DATABRICKS_CLIENT_ID
+ # - DATABRICKS_HOST
+ # - DATABRICKS_WORKSPACE_ID
```

### 2. **lib/databricks/client.ts** - Usa CLIENT_SECRET

```diff
export function getDatabricksConfig() {
  const config = {
-   host: process.env.DATABRICKS_SERVER_HOSTNAME,
-   token: process.env.DATABRICKS_TOKEN,
+   host: process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST,
+   token: process.env.DATABRICKS_CLIENT_SECRET || process.env.DATABRICKS_TOKEN,
    catalog: process.env.DATABRICKS_CATALOG || "fabio_goncalves",
    schema: process.env.DATABRICKS_SCHEMA || "customer_cielo",
    volume: process.env.DATABRICKS_VOLUME || "pdf",
  };

  if (!config.host) {
-   throw new Error("DATABRICKS_SERVER_HOSTNAME is not configured");
+   throw new Error("DATABRICKS_SERVER_HOSTNAME or DATABRICKS_HOST is not configured");
  }

+ if (!config.token) {
+   throw new Error("DATABRICKS_CLIENT_SECRET or DATABRICKS_TOKEN is not configured");
+ }

  return config;
}
```

---

## 🚀 Deployment Atual

**Deployment ID:** `01f0f659157a1fe092bb63f845730856`  
**Status:** ✅ RUNNING (App started successfully)  
**URL:** https://databricks-contracts-app-1444828305810485.aws.databricksapps.com  
**Deploy Time:** 2026-01-20 23:38:48 UTC

### Environment Variables (injetadas automaticamente):

```bash
# Databricks injeta automaticamente:
DATABRICKS_APP_NAME=databricks-contracts-app
DATABRICKS_APP_PORT=8000           # ✅ Porta correta
DATABRICKS_APP_URL=https://...
DATABRICKS_CLIENT_ID=0b9b9963-...  # ✅ Service Principal
DATABRICKS_CLIENT_SECRET=***       # ✅ Token do SP
DATABRICKS_HOST=e2-demo-field-eng.cloud.databricks.com
DATABRICKS_WORKSPACE_ID=1444828305810485

# Do app.yaml:
DATABRICKS_CATALOG=fabio_goncalves
DATABRICKS_SCHEMA=customer_cielo
DATABRICKS_VOLUME=pdf
DATABRICKS_WAREHOUSE_ID=09231fd5489fc752
DATABRICKS_SERVER_HOSTNAME=e2-demo-field-eng.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/09231fd5489fc752

# Injetada pelo Databricks (substitui qualquer PORT manual):
PORT=8000  # ✅ Next.js agora usa essa porta
```

---

## 📊 Arquitetura Correta (conforme docs Databricks)

### ✅ Fluxo de Funcionamento:

```
1. Databricks detecta package.json na raiz
   └─> Identifica como Node.js app

2. Databricks executa automaticamente:
   ├─> npm install
   ├─> npm run build
   └─> npm run start  # Conforme app.yaml

3. Next.js inicia e lê PORT do environment
   └─> process.env.PORT = "8000"  # Injetado pelo Databricks

4. App escuta na porta 8000
   └─> Databricks proxy expõe na URL pública

5. Autenticação via Service Principal
   ├─> CLIENT_ID: identificação do SP
   └─> CLIENT_SECRET: token injetado automaticamente
```

### 🔐 Autenticação:

```typescript
// Databricks Apps injeta automaticamente para Service Principal:
DATABRICKS_CLIENT_ID      // Identificador do SP
DATABRICKS_CLIENT_SECRET  // Token (equivalente a PAT)

// No código:
const token = process.env.DATABRICKS_CLIENT_SECRET;
// Use esse token para autenticar nas APIs Databricks
```

---

## 🎯 Melhores Práticas Aplicadas

### ✅ Seguindo as recomendações dos docs:

1. **Não configure PORT manualmente** - Deixe o Databricks injetar
2. **Use CLIENT_SECRET em produção** - Injetado automaticamente
3. **DATABRICKS_TOKEN apenas para dev local** - Para testes locais
4. **Validação de config obrigatória** - Throw error se faltar variável
5. **Fallbacks para flexibilidade** - Suporta dev local e produção

### 📝 Para Desenvolvimento Local:

Crie `.env.local` (não comitar):

```bash
# Local development
DATABRICKS_SERVER_HOSTNAME=e2-demo-field-eng.cloud.databricks.com
DATABRICKS_TOKEN=dapi...  # Seu Personal Access Token
DATABRICKS_CATALOG=fabio_goncalves
DATABRICKS_SCHEMA=customer_cielo
DATABRICKS_VOLUME=pdf
DATABRICKS_WAREHOUSE_ID=09231fd5489fc752
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/09231fd5489fc752
PORT=3000  # Local usa 3000, produção usa 8000
```

---

## ⚠️ Próximos Passos (Permissões)

O app está **rodando**, mas para uploads funcionarem, você precisa:

### 1. Adicionar Volume como Resource

No UI do Databricks:
1. Apps → databricks-contracts-app → Configuration
2. Add Resource → Unity Catalog Volume
3. Configure:
   - Name: `volume`
   - Full Name: `fabio_goncalves.customer_cielo.pdf`
   - Permission: `WRITE_VOLUME`

### 2. Conceder Permissões ao Service Principal

Execute no SQL Editor:

```sql
-- Catalog
GRANT USE CATALOG ON CATALOG fabio_goncalves 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

-- Schema
GRANT USE SCHEMA ON SCHEMA fabio_goncalves.customer_cielo 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

-- Volume (leitura e escrita)
GRANT READ VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;
```

---

## 📚 Referências

- **Databricks Apps - Node.js Support**: Detecta `package.json` automaticamente
- **Environment Variables**: Databricks injeta automaticamente variáveis do sistema
- **Service Principal Auth**: CLIENT_ID e CLIENT_SECRET injetados pelo Databricks
- **Port Configuration**: Sempre use PORT=8000 em produção (injetado automaticamente)

---

## ✅ Status Final

| Item | Status | Observação |
|------|--------|------------|
| **Porta 8000** | ✅ OK | Databricks injeta automaticamente |
| **CLIENT_SECRET** | ✅ OK | Token do Service Principal configurado |
| **Build** | ✅ OK | Compilado com sucesso |
| **Deploy** | ✅ OK | App started successfully |
| **App Status** | ✅ RUNNING | Compute ACTIVE |
| **Permissions** | ⚠️ Pendente | Adicionar Volume Resource no UI |

---

**App URL:** https://databricks-contracts-app-1444828305810485.aws.databricksapps.com

**Acesse agora para testar!** 🚀
