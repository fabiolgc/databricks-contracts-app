# OBO Authentication - On-Behalf-Of User

## 🎯 O que é OBO?

**OBO (On-Behalf-Of)** permite que o app execute ações usando as **permissões do usuário logado** ao invés das permissões do Service Principal do app.

### ✅ Benefícios:

1. **Segurança:** Cada usuário só acessa dados que ele tem permissão no Unity Catalog
2. **Auditoria:** Logs mostram quem fez cada ação (usuário real, não o Service Principal)
3. **Fine-grained permissions:** Respeita políticas de Row-level e Column-level do UC
4. **Compliance:** Essencial para ambientes regulados

---

## 📊 Arquitetura Implementada

### Modo Híbrido (Implementado neste app)

```
┌─────────────────────────────────────────────────────────┐
│ Cliente (Browser)                                       │
│  └─> Autenticado no Databricks via SSO                 │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│ Databricks Apps Proxy                                   │
│  └─> Adiciona header: x-forwarded-access-token         │
│      (token downscoped com os escopos configurados)     │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│ Next.js App (POST /api/upload)                          │
│                                                          │
│  1. Extrai x-forwarded-access-token do header          │
│  2. Se token presente → usa OBO (usuário)              │
│  3. Se token ausente → usa Service Principal (app)     │
│                                                          │
│  uploadToVolume(buffer, fileName, overwrite, userToken) │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│ Databricks Volume API                                   │
│                                                          │
│  ✅ Com OBO: Valida permissões do USUÁRIO no Volume    │
│  ⚠️ Sem OBO: Valida permissões do SERVICE PRINCIPAL    │
└─────────────────────────────────────────────────────────┘
```

---

## ⚙️ Configuração no Databricks

### 1. OBO Habilitado ✅

**Status:** Já configurado no seu app!

- **OAuth2 App Client ID:** `afe7e1e6-93c5-450e-be65-7a5e5b97ef32`
- **User Authorization:** Preview habilitado

### 2. Escopos Configurados ✅

| Escopo | Status | Uso no App |
|--------|--------|------------|
| `files.files` | ✅ Configurado | **Upload de PDFs no Volume** |
| `sql` | ✅ Configurado | Consultas SQL (futuro) |
| `vectorsearch.vector-search-index...` | ✅ Configurado | Vector Search (futuro) |
| `serving.serving-endpoints` | ✅ Configurado | Model Serving (futuro) |
| `iam.current-user:read` | ✅ Default | Informações do usuário |
| `iam.access-control:read` | ✅ Default | Verificar permissões |

---

## 💻 Implementação no Código

### 1. Client Databricks (`lib/databricks/client.ts`)

```typescript
export function getDatabricksConfig(userToken?: string) {
  const config = {
    host: process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST,
    // Priority: User token (OBO) > Service Principal > Local dev token
    token: userToken || process.env.DATABRICKS_CLIENT_SECRET || process.env.DATABRICKS_TOKEN,
    catalog: process.env.DATABRICKS_CATALOG || "fabio_goncalves",
    schema: process.env.DATABRICKS_SCHEMA || "customer_cielo",
    volume: process.env.DATABRICKS_VOLUME || "pdf",
    authMethod: userToken ? "OBO" : "Service Principal",
  };
  
  // ... validação ...
  
  return config;
}
```

**Features:**
- ✅ Aceita `userToken` opcional
- ✅ Fallback automático para Service Principal
- ✅ Logging do método de autenticação usado

### 2. Upload Function

```typescript
export async function uploadToVolume(
  file: Buffer,
  fileName: string,
  overwrite: boolean = false,
  userToken?: string  // 🔑 Novo parâmetro
): Promise<{ success: boolean; path: string; error?: string }> {
  const config = getDatabricksConfig(userToken);
  
  console.log(`📤 Starting upload (${config.authMethod}): ${fileName}`);
  
  // ... rest of implementation ...
}
```

### 3. API Route (`app/api/upload/route.ts`)

```typescript
export async function POST(request: NextRequest) {
  // 🔑 Extrai user token do header (injetado pelo Databricks)
  const userToken = request.headers.get("x-forwarded-access-token");
  const authMethod = userToken ? "OBO (user token)" : "Service Principal";
  
  console.log(`🔐 Authentication method: ${authMethod}`);
  
  // ... processar arquivo ...
  
  // 🔑 Passa user token para a função de upload
  const result = await uploadToVolume(buffer, file.name, overwrite, userToken || undefined);
  
  // ... rest ...
}
```

---

## 🔐 Permissões Necessárias

### Quando usar OBO (recomendado):

Cada **usuário** precisa ter permissões no Unity Catalog:

```sql
-- Conceder ao USUÁRIO (não ao Service Principal)
GRANT USE CATALOG ON CATALOG fabio_goncalves TO `user@company.com`;
GRANT USE SCHEMA ON SCHEMA fabio_goncalves.customer_cielo TO `user@company.com`;
GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf TO `user@company.com`;
```

### Quando usar Service Principal (fallback):

O **Service Principal do app** precisa de permissões:

```sql
-- Conceder ao SERVICE PRINCIPAL
GRANT USE CATALOG ON CATALOG fabio_goncalves 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

GRANT USE SCHEMA ON SCHEMA fabio_goncalves.customer_cielo 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;

GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `0b9b9963-0746-4266-8bb6-a079df8e747f`;
```

---

## 📝 Logs e Debugging

### Logs agora mostram método de autenticação:

```bash
# No console do app:
🔐 Authentication method: OBO (user token)
📤 Starting upload (OBO): contract.pdf
🔍 Checking file existence (OBO): /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
✅ File uploaded successfully (OBO): /Volumes/fabio_goncalves/customer_cielo/pdf/contract.pdf
```

### Se OBO não estiver disponível:

```bash
🔐 Authentication method: Service Principal
📤 Starting upload (Service Principal): contract.pdf
✅ File uploaded successfully (Service Principal): /Volumes/.../contract.pdf
```

---

## 🎯 Quando usar cada modo?

### Use OBO (On-Behalf-Of User) quando:

- ✅ Diferentes usuários devem ter acessos diferentes aos dados
- ✅ Você precisa de auditoria por usuário nos logs do UC
- ✅ Você tem políticas de Row/Column-level security no UC
- ✅ Ambiente de produção com múltiplos usuários

**Exemplo:** Sistema de contratos onde usuários só veem seus próprios contratos.

### Use Service Principal quando:

- ✅ Todos os usuários do app devem ter o mesmo nível de acesso
- ✅ O app gerencia dados compartilhados (não sensíveis por usuário)
- ✅ Simplicidade é mais importante que granularidade

**Exemplo:** App de dashboards públicos, dados agregados.

---

## 🔍 Verificar se OBO está funcionando

### 1. Checar logs do app:

```bash
databricks apps logs databricks-contracts-app | grep "Authentication method"
```

Deve mostrar: `🔐 Authentication method: OBO (user token)`

### 2. Testar permissões:

1. **Usuário COM permissão:**
   - Faz upload → ✅ Sucesso

2. **Usuário SEM permissão:**
   - Faz upload → ❌ Erro: "Permission denied. User does not have WRITE_VOLUME permission"

Se ambos conseguem fazer upload, OBO não está ativo (usando Service Principal).

---

## ⚠️ Troubleshooting

### Upload falha com "Permission denied" (OBO ativo):

**Causa:** Usuário não tem permissão no Volume.

**Solução:**
```sql
GRANT WRITE VOLUME ON VOLUME fabio_goncalves.customer_cielo.pdf 
  TO `user@company.com`;
```

### Todos conseguem fazer upload (quando não deveriam):

**Causa:** OBO não está sendo usado (Service Principal tem permissões).

**Verificar:**
1. Logs mostram "Service Principal" ao invés de "OBO"?
2. Header `x-forwarded-access-token` está chegando?
3. User authorization está habilitado no UI do Databricks?

---

## 🚀 Best Practices (da documentação Databricks)

### ✅ Use Service Principal para:

- Armazenar estado da aplicação (tabelas internas, configs)
- Operações de sistema que não dependem do usuário
- Dados compartilhados entre todos os usuários

### ✅ Use OBO para:

- Acessar dados do usuário (respeitar permissões UC)
- Upload/download de arquivos pessoais
- Consultas SQL com row/column-level security
- Qualquer operação que precise de auditoria por usuário

### ✅ Modo Híbrido (implementado neste app):

```typescript
// ✅ RECOMENDADO: Tenta OBO, fallback para Service Principal
const result = await uploadToVolume(buffer, file, false, userToken || undefined);

// ❌ NÃO RECOMENDADO: Sempre usa Service Principal
const result = await uploadToVolume(buffer, file, false);  // Sem userToken
```

---

## 📊 Status Atual do App

| Componente | Status | Observação |
|------------|--------|------------|
| **OBO Habilitado no Databricks** | ✅ Sim | Preview ativo |
| **Escopos Configurados** | ✅ Sim | `files.files`, `sql`, etc |
| **Código com suporte OBO** | ✅ Sim | Híbrido implementado |
| **Logs de autenticação** | ✅ Sim | Mostra método usado |
| **Mensagens de erro melhoradas** | ✅ Sim | 403, 404 explicados |
| **Permissões usuário** | ⚠️ Configurar | Execute SQLs acima |

---

## 🔗 Referências

- **Databricks Apps OBO Docs:** https://docs.databricks.com/apps/user-authorization.html
- **Unity Catalog Permissions:** https://docs.databricks.com/data-governance/unity-catalog/manage-privileges/
- **OAuth2 Scopes:** Configurados no UI do Databricks Apps

---

**Service Principal ID:** `0b9b9963-0746-4266-8bb6-a079df8e747f`  
**OAuth2 Client ID:** `afe7e1e6-93c5-450e-be65-7a5e5b97ef32`

✅ **OBO está pronto para uso!** Configure as permissões dos usuários no Unity Catalog.
