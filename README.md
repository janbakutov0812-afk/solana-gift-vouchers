# Solgift — Solana gift vouchers

Интерфейс на React для подарочных ваучеров SOL/USDC. Подключение Phantom, баланс и подписание funding-транзакции идут через Solana Wallet Adapter; подтверждение проверяется через RPC.

## Запуск

```bash
npm install
cp .env.example .env
npm run dev
```

По умолчанию используется Solana devnet. Для funding и claim заполните `VITE_VOUCHER_API_URL` адресом escrow backend. Без него frontend намеренно не отправляет средства. Контракт endpoint-ов и требования к backend описаны в [BACKEND_API.md](./BACKEND_API.md).

**Важно:** проект не содержит escrow backend и private key. Публичный frontend не может безопасно управлять приватным ключом escrow. Не используйте mainnet, пока не развернуты backend/PDA escrow, проверка funding транзакций, защита от повторного claim и система управления секретами.
