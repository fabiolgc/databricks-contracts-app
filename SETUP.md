# Setup Guide - Databricks Contracts App

## Local Development

Para executar o app localmente, você precisa configurar as variáveis de ambiente.

### 1. Criar arquivo `.env.local`

Crie um arquivo `.env.local` na raiz do projeto com o seguinte conteúdo:

```bash
# Databricks Configuration
# Get a personal access token from: User Settings > Developer > Access Tokens
DATABRICKS_TOKEN=your_token_here

# Server configuration
DATABRICKS_SERVER_HOSTNAME=e2-demo-field-eng.cloud.databricks.com

# Unity Catalog configuration
DATABRICKS_CATALOG=fabio_goncalves
DATABRICKS_SCHEMA=customer_cielo
DATABRICKS_VOLUME=pdf

# SQL Warehouse
DATABRICKS_WAREHOUSE_ID=09231fd5489fc752
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/09231fd5489fc752
```

### 2. Instalar dependências

```bash
npm install
```

### 3. Executar em desenvolvimento

```bash
npm run dev
```

O app estará disponível em: http://localhost:3000

## Deploy para Databricks Apps

Quando deployado para Databricks Apps, o token é automaticamente fornecido pela plataforma (service principal authentication). Não é necessário configurar `DATABRICKS_TOKEN` manualmente.

```bash
databricks apps deploy databricks-contracts-app --source-code-path "/Workspace/Users/<user>@databricks.com/databricks-contracts-app"
```

## Funcionalidades

### Upload de Arquivos

1. Arraste arquivos PDF para a área de upload ou clique para selecionar
2. Clique em "Importar" para enviar os arquivos para o Databricks Volume
3. Acompanhe o progresso de cada arquivo
4. Veja mensagens de sucesso/erro ao final do processo

### Logging

- Todos os erros são logados no console (servidor)
- Mensagens de toast aparecem para o usuário final
- Status de cada arquivo é exibido em tempo real

## Troubleshooting

### Erro de autenticação

- Verifique se o `DATABRICKS_TOKEN` está configurado corretamente
- Confirme que o token tem permissões para acessar o Volume

### Erro de upload

- Verifique se o Volume existe: `/Volumes/{catalog}/{schema}/{volume}`
- Confirme que o service principal tem permissões `READ_VOLUME` e `WRITE_VOLUME`
