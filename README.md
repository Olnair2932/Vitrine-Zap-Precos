# Vitrine Zap — Consulta de Preços por SKU

Aplicação independente com página pública, painel administrativo e API.

## Rotas
- / — consulta pública de preços
- /admin — painel administrativo
- /health — verificação do serviço
- /api/v1/precos/:sku — consulta pública por SKU
- /api/v1/agente/precos/:sku — API protegida para futuro agente de IA

## Variáveis de ambiente no Render
- FIREBASE_DATABASE_URL
- FIREBASE_SERVICE_ACCOUNT_JSON
- ADMIN_USERNAME
- ADMIN_PASSWORD
- SESSION_SECRET
- AGENT_API_KEY

A persistência utiliza exclusivamente o caminho
vitrine_zap_tabela_precos_sku_v1 no Firebase Realtime Database.

Nunca publique credenciais privadas no GitHub. Não altere os caminhos
ou as regras existentes do Firebase para implantar este projeto.
