# Configuração de Recursos Databricks Apps

## 🚨 Problema Identificado e Corrigido

O app estava com um recurso "volume" mal configurado no `app.yaml`, causando falha no carregamento.

**Correção aplicada:**
- ✅ Removida referência `valueFrom: volume` inválida
- ✅ Token do Service Principal agora vem de `DATABRICKS_ADMIN_TOKEN`
- ✅ Path do Volume construído dinamicamente no código

## 📋 Status Atual dos Recursos

### ✅ Configurados Corretamente:
1. **SQL Warehouse** (`09231fd5489fc752`)
   - Permissão: `CAN_USE`
   - Status: ✅ Configurado

2. **Secrets**
   - `DATABRICKS_ADMIN_TOKEN` - Token do Service Principal
   - `DATABRICKS_APP_NAME` - Nome do app
   - Status: ✅ Configurados

### ⚠️ Recursos que Precisam de Configuração Manual:

3. **Unity Catalog Volume** (fabio_goncalves.customer_cielo.pdf)
   - Status: ⚠️ Existe mas não está configurado como Resource
   - Precisa: Adicionar no UI do Databricks Apps

---

## 🔧 Como Configurar os Recursos no UI

### 1. Adicionar Unity Catalog Volume

1. Acesse o Databricks Workspace
2. Vá em **Apps** → **databricks-contracts-app** → **Configuration**
3. Clique em **Add Resource** → **Unity Catalog Volume**
4. Configure:
   ```
   Name: volume
   Full Name: fabio_goncalves.customer_cielo.pdf
   Permission: WRITE_VOLUME (para upload) ou READ_VOLUME (apenas leitura)
   ```
5. Clique em **Save**

### 2. Verificar Permissões do Service Principal

O Service Principal do app precisa ter permissões no Unity Catalog:

```sql
-- Catalog
GRANT USE CATALOG ON CATALOG fabio_goncalves TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

-- Schema
GRANT USE SCHEMA ON SCHEMA fabio_goncalves.customer_cielo TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

-- Volume (para leitura e escrita)
GRANT READ VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;
GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;
```

### 3. Habilitar OBO (On-Behalf-Of) [Opcional]

Se você quiser que o app respeite as permissões do usuário logado:

1. Vá em **Apps** → **databricks-contracts-app** → **Configuration**
2. Ative **User authorization (OBO)**
3. Adicione escopos:
   - `sql` - Para consultas SQL
   - `files.files` - Para operações em Volumes
4. Reinicie o app após habilitar

**Nota:** Com OBO, cada usuário precisa ter suas próprias permissões no UC.

---

## 📊 Arquitetura do App (conforme docs Databricks)

### ✅ Estrutura Atual (Next.js SSR em Node.js)

```
databricks-contracts-app/
├── app/
│   ├── (shell)/
│   │   ├── import/page.tsx        # Página de upload
│   │   └── layout.tsx             # Layout com navegação
│   ├── api/
│   │   └── upload/route.ts        # API de upload
│   ├── layout.tsx                 # Root layout
│   └── page.tsx                   # Home (redirect)
├── components/
│   └── nav/top-nav.tsx            # Navegação
├── lib/
│   └── databricks/client.ts       # Cliente Databricks
├── app.yaml                       # ✅ Configuração corrigida
├── package.json                   # Scripts: build, start
└── next.config.ts                 # Config Next.js
```

### 🔄 Fluxo de Deploy (automático)

1. **Databricks detecta** `package.json` na raiz
2. **Executa automaticamente:**
   ```bash
   npm install
   npm run build
   npm run start  # Conforme comando no app.yaml
   ```
3. **App roda** na porta 3000 (Next.js)
4. **Databricks proxy** expõe via URL pública

---

## 🎯 Melhores Práticas (dos docs)

### ✅ Já Implementado:

1. **Node.js Runtime**: App usa Next.js com SSR
2. **Service Principal Auth**: Token via `DATABRICKS_ADMIN_TOKEN`
3. **Environment Variables**: Todas via `app.yaml`
4. **Resources**: SQL Warehouse configurado com permissões
5. **Build Scripts**: `package.json` com build e start

### 📝 Recomendações Adicionais:

1. **Não hardcode tokens** - ✅ Usamos `valueFrom`
2. **Use Resources para tudo** - ⚠️ Volume precisa ser adicionado
3. **OBO para multi-user** - ⚠️ Opcional, não configurado ainda
4. **Least Privilege** - ✅ Service Principal só tem CAN_USE no Warehouse

---

## 🚀 Após Configurar o Volume

Depois de adicionar o Volume como Resource no UI:

1. **Atualize o app.yaml** (opcional, se quiser usar `valueFrom`):
   ```yaml
   - name: VOLUME_PATH
     valueFrom: volume
   ```

2. **Re-deploy**:
   ```bash
   databricks apps deploy databricks-contracts-app \
     --source-code-path /Workspace/Users/fabio.goncalves@databricks.com/databricks-contracts-app
   ```

3. **Teste o upload** pela interface

---

## 📞 Troubleshooting

### App retorna "502 Bad Gateway"
- Verifique se o app está RUNNING: `databricks apps get databricks-contracts-app`
- Aguarde ~1 minuto após deploy para o app inicializar

### Upload falha com erro de permissão
- Verifique permissões do Service Principal no Volume (WRITE_VOLUME)
- Verifique se o token está configurado corretamente

### "Resource not found" ao acessar Volume
- Verifique se o Volume existe: `/Volumes/fabio_goncalves/customer_cielo/pdf`
- Execute no SQL Editor do Databricks:
  ```sql
  SHOW VOLUMES IN fabio_goncalves.customer_cielo;
  ```

---

## 🔗 Referências

- **Databricks Apps Docs**: https://docs.databricks.com/apps/
- **Next.js no Databricks**: Suportado via Node.js runtime
- **Unity Catalog Volumes**: https://docs.databricks.com/volumes/
- **Service Principal Auth**: https://docs.databricks.com/dev-tools/service-principals.html

---

**App URL**: https://databricks-contracts-app-1444828305810485.aws.databricksapps.com

**Service Principal**: `0b9b9963-0746-4266-8bb6-a079df8e747f`
