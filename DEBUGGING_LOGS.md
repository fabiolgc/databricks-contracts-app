# Debugging Logs - Guia Completo

## 🎯 Logging Detalhado Implementado

O app agora possui **logging comprehensivo** em todas as etapas do processo de upload, facilitando o diagnóstico de problemas.

---

## 📊 Estrutura dos Logs

### 1. **Request ID** (Rastreamento)

Cada operação recebe um ID único para rastrear o fluxo completo:

```bash
[UPLOAD-a1b2c3d4]  # Upload principal
[CHECK-e5f6g7h8]   # Verificação de arquivo existente
```

### 2. **Separadores Visuais**

```bash
════════════════════════════════════════  # Upload principal
────────────────────────────────────────  # Operações secundárias
```

### 3. **Emojis Indicadores**

```bash
📤  Início de upload
🔧  Verificação de environment
📋  Informações de configuração
🔐  Autenticação
🔍  Verificação/busca
🌐  Requisição HTTP
📡  Resposta HTTP
✅  Sucesso
❌  Erro
⚠️  Aviso
💥  Exception/Crash
```

---

## 🔍 Como Ver os Logs

### Opção 1: Via CLI Databricks

```bash
# Ver logs em tempo real (streaming)
databricks apps logs databricks-contracts-app

# Ver últimas 100 linhas
databricks apps logs databricks-contracts-app | tail -100

# Filtrar por palavra-chave
databricks apps logs databricks-contracts-app | grep "UPLOAD"
databricks apps logs databricks-contracts-app | grep "ERROR"
databricks apps logs databricks-contracts-app | grep "Authentication"

# Ver apenas erros
databricks apps logs databricks-contracts-app | grep -E "❌|💥"

# Ver apenas sucessos
databricks apps logs databricks-contracts-app | grep "✅"

# Salvar logs em arquivo
databricks apps logs databricks-contracts-app > app-logs.txt
```

### Opção 2: Via UI do Databricks

1. Acesse: **Databricks Workspace** → **Compute** → **Apps**
2. Clique em **databricks-contracts-app**
3. Vá para a aba **Logs**
4. Use o filtro de busca ou scroll para encontrar entradas específicas

### Opção 3: Logz.io (se configurado)

Se você tiver Logz.io configurado, os logs são enviados automaticamente para lá.

---

## 📝 Exemplo de Log Completo de Upload

### Upload Bem-Sucedido:

```bash
================================================================================
📤 [a1b2c3d4] Upload request received at 2026-01-20T23:47:15Z
================================================================================

🔧 [a1b2c3d4] Environment check:
  - DATABRICKS_HOST: ✅ Set
  - DATABRICKS_SERVER_HOSTNAME: ✅ Set
  - DATABRICKS_CLIENT_SECRET: ✅ Set (***)
  - DATABRICKS_CLIENT_ID: 0b9b9963-0746-4266-8bb6-a079df8e747f
  - DATABRICKS_CATALOG: fabio_goncalves
  - DATABRICKS_SCHEMA: customer_cielo
  - DATABRICKS_VOLUME: pdf

📋 [a1b2c3d4] Request headers:
{
  "content-type": "multipart/form-data; boundary=...",
  "x-forwarded-access-token": "✅ Present (***)",
  "user-agent": "Mozilla/5.0...",
  ...
}

🔐 [a1b2c3d4] Authentication method: OBO (user token)
  - User token length: 543 chars
  - User token prefix: dapi1234567890abcdef...

📦 [a1b2c3d4] Parsing form data...
✅ [a1b2c3d4] Form data parsed successfully

📋 [a1b2c3d4] Form data contents:
  - file: ✅ Present
  - overwrite: No

🔍 [a1b2c3d4] Validating file...
  - Name: contract.pdf
  - Type: application/pdf
  - Size: 2458624 bytes (2.34 MB)

✅ [a1b2c3d4] File type is valid (PDF)
✅ [a1b2c3d4] File size is valid

📄 [a1b2c3d4] Processing file: contract.pdf (2.34MB)

🔄 [a1b2c3d4] Converting file to buffer...
✅ [a1b2c3d4] Buffer created: 2458624 bytes

🚀 [a1b2c3d4] Starting upload to Databricks Volume...
  - Auth method: OBO (user token)
  - Overwrite: false

════════════════════════════════════════════════════════════════════════════════
📤 [UPLOAD-e5f6g7h8] Starting upload process
════════════════════════════════════════════════════════════════════════════════

📋 [UPLOAD-e5f6g7h8] Upload configuration:
  - File name: contract.pdf
  - File size: 2458624 bytes (2.34 MB)
  - Auth method: OBO
  - Overwrite mode: NO
  - Host: e2-demo-field-eng.cloud.databricks.com
  - Volume path: /Volumes/fabio_goncalves/customer_cielo/pdf
  - Full file path: /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf

🔍 [UPLOAD-e5f6g7h8] Overwrite disabled - checking if file exists...

────────────────────────────────────────────────────────────────
🔍 [CHECK-i9j0k1l2] Checking file existence
────────────────────────────────────────────────────────────────

📋 [CHECK-i9j0k1l2] Configuration:
  - Auth method: OBO
  - Host: e2-demo-field-eng.cloud.databricks.com
  - Catalog: fabio_goncalves
  - Schema: customer_cielo
  - Volume: pdf
  - File path: /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf

🌐 [CHECK-i9j0k1l2] Making HTTP HEAD request:
  - URL: https://e2-demo-field-eng.cloud.databricks.com/api/2.0/fs/files/Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
  - Method: HEAD
  - Authorization: Bearer dapi12345678901234...

📡 [CHECK-i9j0k1l2] HTTP Response received (245ms):
  - Status: 404 Not Found
  - Headers: {
      "content-type": "application/json",
      "x-request-id": "abc-def-ghi-jkl"
    }

✓ [CHECK-i9j0k1l2] File DOES NOT exist: /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
────────────────────────────────────────────────────────────────

✓ [UPLOAD-e5f6g7h8] File does not exist, proceeding with upload

🌐 [UPLOAD-e5f6g7h8] Making HTTP PUT request:
  - URL: https://e2-demo-field-eng.cloud.databricks.com/api/2.0/fs/files/Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
  - Method: PUT
  - Content-Type: application/octet-stream
  - Authorization: Bearer dapi12345678901234...
  - Body size: 2458624 bytes

📡 [UPLOAD-e5f6g7h8] HTTP Response received (1834ms):
  - Status: 200 OK
  - Headers: {
      "content-type": "application/json",
      "x-request-id": "mno-pqr-stu-vwx"
    }

✅ [UPLOAD-e5f6g7h8] Upload SUCCESSFUL!
  - File: contract.pdf
  - Path: /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
  - Size: 2.34 MB
  - Duration: 1834ms
  - Auth: OBO
════════════════════════════════════════════════════════════════════════════════

📊 [a1b2c3d4] Upload result: {
  "success": true,
  "path": "/Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf",
  "error": "none"
}

✅ [a1b2c3d4] Upload successful!
  - File: contract.pdf
  - Path: /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
  - Size: 2.34 MB
  - Returning HTTP 200
================================================================================
```

---

### Upload com Erro de Permissão:

```bash
================================================================================
📤 [m3n4o5p6] Upload request received at 2026-01-20T23:50:00Z
================================================================================

[... configuração e validação ...]

🌐 [UPLOAD-q7r8s9t0] Making HTTP PUT request:
  - URL: https://e2-demo-field-eng.cloud.databricks.com/api/2.0/fs/files/Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
  - Method: PUT
  - Content-Type: application/octet-stream
  - Authorization: Bearer dapi12345678901234...
  - Body size: 2458624 bytes

📡 [UPLOAD-q7r8s9t0] HTTP Response received (432ms):
  - Status: 403 Forbidden
  - Headers: {
      "content-type": "application/json"
    }

❌ [UPLOAD-q7r8s9t0] Upload failed!
  - HTTP Status: 403 Forbidden
  - Response body: {"error_code":"PERMISSION_DENIED","message":"User does not have WRITE_VOLUME permission"}
  - Issue: PERMISSION DENIED
  - Likely cause: Service Principal or User lacks WRITE_VOLUME grant
  - Solution: Run SQL: GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf TO principal
════════════════════════════════════════════════════════════════════════════════

❌ [m3n4o5p6] Upload failed for contract.pdf:
  - Error: Permission denied. User does not have WRITE_VOLUME permission on /Volumes/fabio_goncalves/customer_cielo/pdf
  - Returning HTTP 500
================================================================================
```

---

## 🔍 Diagnóstico de Problemas Comuns

### 1. **App não carrega (502 Bad Gateway)**

**Procurar nos logs:**
```bash
databricks apps logs databricks-contracts-app | grep -E "Port|PORT|listening"
```

**Sinais esperados:**
- `PORT=8000` ou `Listening on port 8000`

**Problema comum:**
- App tentando usar porta errada

**Solução:**
- Verificar `app.yaml` (não deve definir PORT manualmente)
- Databricks injeta PORT=8000 automaticamente

---

### 2. **Upload falha com "Permission Denied"**

**Procurar nos logs:**
```bash
databricks apps logs databricks-contracts-app | grep -E "403|PERMISSION|Permission"
```

**Sinais:**
```
❌ HTTP Status: 403 Forbidden
  - Issue: PERMISSION DENIED
  - Solution: GRANT WRITE VOLUME ON VOLUME ...
```

**Causa:**
- Service Principal ou usuário não tem permissão no Volume

**Solução:**
```sql
-- Para Service Principal
GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

-- Para usuário (OBO)
GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `user@company.com`;
```

---

### 3. **Upload falha com "Volume not found"**

**Procurar nos logs:**
```bash
databricks apps logs databricks-contracts-app | grep -E "404|NOT FOUND|Volume not"
```

**Sinais:**
```
❌ HTTP Status: 404 Not Found
  - Issue: VOLUME NOT FOUND
  - Solution: Verify Volume exists
```

**Causa:**
- Volume path incorreto ou Volume não existe

**Solução:**
```sql
-- Verificar se Volume existe
SHOW VOLUMES IN fabio_goncalves.customer_cielo;

-- Criar Volume se não existir
CREATE EXTERNAL VOLUME fabio_goncalves.customer_cielo.pdf
  LOCATION 's3://your-bucket/path/';
```

---

### 4. **Authentication Failed (Token inválido)**

**Procurar nos logs:**
```bash
databricks apps logs databricks-contracts-app | grep -E "401|Authentication|DATABRICKS_CLIENT_SECRET"
```

**Sinais:**
```
❌ HTTP Status: 401 Unauthorized
  - Issue: AUTHENTICATION FAILED
  - Likely cause: Token is invalid, expired, or missing
```

**Verificar:**
```bash
# No log, procurar por:
🔧 Environment check:
  - DATABRICKS_CLIENT_SECRET: ❌ Missing  # <-- Problema!
```

**Solução:**
- Verificar se `DATABRICKS_CLIENT_SECRET` está sendo injetado
- Verificar se Service Principal está configurado corretamente
- Testar token manualmente com curl

---

### 5. **OBO não está funcionando**

**Procurar nos logs:**
```bash
databricks apps logs databricks-contracts-app | grep "Authentication method"
```

**Esperado (OBO ativo):**
```
🔐 Authentication method: OBO (user token)
  - User token length: 543 chars
```

**Problema (OBO não ativo):**
```
🔐 Authentication method: Service Principal
```

**Causa:**
- Header `x-forwarded-access-token` não está chegando
- OBO não habilitado no Databricks

**Solução:**
1. Verificar no UI: Apps → databricks-contracts-app → Authorization
2. Confirmar que "User authorization" está habilitado
3. Verificar escopos configurados (`files.files`)

---

## 📊 Comandos Úteis

### Filtros por tipo de operação:

```bash
# Ver apenas uploads
databricks apps logs databricks-contracts-app | grep "UPLOAD-"

# Ver apenas checks de arquivo
databricks apps logs databricks-contracts-app | grep "CHECK-"

# Ver apenas erros e exceções
databricks apps logs databricks-contracts-app | grep -E "❌|💥"

# Ver detalhes de autenticação
databricks apps logs databricks-contracts-app | grep -E "🔐|Authentication|OBO|Service Principal"

# Ver requisições HTTP
databricks apps logs databricks-contracts-app | grep -E "🌐|Making HTTP"

# Ver respostas HTTP
databricks apps logs databricks-contracts-app | grep -E "📡|HTTP Response"

# Ver environment check
databricks apps logs databricks-contracts-app | grep -E "🔧|Environment check" -A 10
```

### Logs em tempo real com filtro:

```bash
# Seguir logs em tempo real (simular tail -f)
watch -n 2 'databricks apps logs databricks-contracts-app | tail -50'

# Ver apenas novas entradas de upload
databricks apps logs databricks-contracts-app | grep --line-buffered "Upload request received"
```

---

## 🎯 Checklist de Diagnóstico

Quando o app não funcionar, verifique nesta ordem:

1. **App está rodando?**
   ```bash
   databricks apps get databricks-contracts-app | grep state
   ```
   Esperado: `"state": "RUNNING"`

2. **Port correto?**
   ```bash
   databricks apps logs databricks-contracts-app | grep -i port
   ```
   Esperado: `PORT=8000`

3. **Environment correto?**
   ```bash
   databricks apps logs databricks-contracts-app | grep "Environment check" -A 10
   ```
   Verificar se todas as variáveis têm `✅ Set`

4. **Token presente?**
   ```bash
   databricks apps logs databricks-contracts-app | grep "DATABRICKS_CLIENT_SECRET"
   ```
   Esperado: `✅ Set (***)`

5. **Requisições chegando?**
   ```bash
   databricks apps logs databricks-contracts-app | grep "Upload request received"
   ```
   Se não aparecer nada, o problema é antes do app (proxy, rede)

6. **HTTP Status Code?**
   ```bash
   databricks apps logs databricks-contracts-app | grep "HTTP Response"
   ```
   - 200 = Sucesso
   - 403 = Permissão negada
   - 404 = Volume não encontrado
   - 401 = Autenticação falhou

---

## 💡 Dicas Finais

1. **Sempre use Request ID** para rastrear um upload específico do início ao fim
2. **Procure por Exception stack traces** (`💥`) para erros críticos
3. **Verifique duration** nos logs para identificar operações lentas
4. **Compare logs de sucesso vs erro** para identificar diferenças
5. **Save logs importantes** em arquivo para análise posterior

---

## 📦 Deployment Atual

**Deployment ID:** `01f0f65a5105167d8bbd1cc201e56ebd`  
**Status:** ✅ RUNNING  
**URL:** https://databricks-contracts-app-1444828305810485.aws.databricksapps.com  
**Deploy Time:** 2026-01-20 23:47:09 UTC

---

## 🔗 Comandos Rápidos

```bash
# Ver últimos 50 logs
databricks apps logs databricks-contracts-app | tail -50

# Ver erros
databricks apps logs databricks-contracts-app | grep -E "❌|💥|ERROR"

# Ver autenticação
databricks apps logs databricks-contracts-app | grep "Authentication method"

# Ver uploads completos (últimas 200 linhas)
databricks apps logs databricks-contracts-app | tail -200 | grep -E "Upload request|Upload SUCCESSFUL|Upload failed"

# Salvar logs completos
databricks apps logs databricks-contracts-app > debug-$(date +%Y%m%d-%H%M%S).log
```

---

✅ **Logging comprehensivo está ativo!** Agora você pode diagnosticar exatamente onde o app está parando.
