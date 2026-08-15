# Stats Engine 1.0.5

Pacote raiz único para Render/GitHub.

Fluxo:
1. Recebe MatchID.
2. Abre MatchStats oficial no servidor.
3. Pesquisa o MatchID.
4. Localiza e aciona View com múltiplos fallbacks (texto, Operation, frames e href).
5. Captura TeamData e PlayerData.
6. Exibe os dados e permite baixar o JSON completo.

Playwright: 1.62.1
Docker: mcr.microsoft.com/playwright:v1.62.1-noble
