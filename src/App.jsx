import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js'
import { claimGiftInstruction, createGiftInstruction, decodeBase64Url } from './solgift-program.js'
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, Gift,
  LockKeyhole, Menu, ShieldCheck, Sparkles, Wallet, X, Zap,
} from 'lucide-react'

const VOUCHER_API = import.meta.env.VITE_VOUCHER_API_URL || (import.meta.env.PROD ? window.location.origin : '')

async function voucherApi(path, body) {
  if (!VOUCHER_API) throw new Error('Сервис ваучеров не настроен. Попробуй позже.')
  const response = await fetch(`${VOUCHER_API.replace(/\/$/, '')}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.status === 'error') throw new Error(result.message || result.error || `Ошибка сервиса (${response.status})`)
  return result
}

async function confirmSubmittedTransaction(connection, strategy) {
  const signature = typeof strategy === 'string' ? strategy : strategy.signature
  try {
    const confirmation = await connection.confirmTransaction(strategy, 'confirmed')
    if (confirmation.value.err) throw new Error('Транзакция завершилась ошибкой в Solana')
    return confirmation
  } catch (error) {
    // A blockhash-expiry timeout can race with confirmation reaching the RPC.
    // Check transaction history before telling the user that an already landed
    // payment failed; this also lets the caller continue with API registration.
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    if (status?.err) throw new Error('Транзакция завершилась ошибкой в Solana')
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { value: { err: null } }

    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    })
    if (transaction?.meta?.err) throw new Error('Транзакция завершилась ошибкой в Solana')
    if (transaction) return { value: { err: null } }

    if (error?.name === 'TransactionExpiredBlockheightExceededError') {
      throw new Error('Срок подтверждения транзакции истёк, и в истории Solana она пока не найдена. Сохрани подпись и проверь её в Solscan Devnet.')
    }
    throw error
  }
}

const templates = [
  { id: 'birthday', title: 'С днём рождения', emoji: '🎂', tag: 'CELEBRATE', style: 'birthday' },
  { id: 'coffee', title: 'На кофе', emoji: '☕', tag: 'LITTLE TREAT', style: 'coffee' },
  { id: 'thanks', title: 'Спасибо!', emoji: '✳', tag: 'JUST BECAUSE', style: 'thanks' },
  { id: 'study', title: 'Для учёбы', emoji: '📚', tag: 'GOOD LUCK', style: 'study' },
]

const initialVoucher = {
  template: templates[0],
  currency: 'SOL',
  amount: '0.25',
  message: 'Пусть этот год будет ярким ✨',
  link: 'https://solgift.app/g/sol-7Kp9xQ',
}

const slideVariants = {
  initial: { opacity: 0, y: 20, filter: 'blur(5px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, filter: 'blur(4px)', transition: { duration: 0.18 } },
}

function formatAmount(amount, currency) {
  const number = Number(amount)
  if (!Number.isFinite(number)) return `0 ${currency}`
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: currency === 'SOL' ? 4 : 2 }).format(number)} ${currency}`
}

function SolMark({ small = false }) {
  return <span className={`sol-mark ${small ? 'sol-mark-small' : ''}`} aria-label="Solana"><i /><i /><i /></span>
}

function Button({ children, onClick, variant = 'primary', className = '', type = 'button', disabled = false }) {
  return (
    <motion.button
      type={type}
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { scale: 1.025, y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      className={`button button-${variant} ${className}`}
    >
      {children}
    </motion.button>
  )
}

function WalletConnection({ onToast }) {
  const { connection } = useConnection()
  const { publicKey, connected, connect, disconnect, wallet } = useWallet()
  const { setVisible } = useWalletModal()
  const [balance, setBalance] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (!connected || !publicKey) { setBalance(null); return () => { active = false } }
    connection.getBalance(publicKey, 'confirmed')
      .then((lamports) => { if (active) setBalance(lamports / LAMPORTS_PER_SOL) })
      .catch(() => { if (active) setBalance(null) })
    const subscription = connection.onAccountChange(publicKey, (account) => {
      if (active) setBalance(account.lamports / LAMPORTS_PER_SOL)
    }, 'confirmed')
    return () => { active = false; connection.removeAccountChangeListener(subscription) }
  }, [connection, connected, publicKey])

  async function handleClick() {
    try {
      setBusy(true)
      if (connected) await disconnect()
      else if (wallet) await connect()
      else setVisible(true)
    } catch (error) {
      onToast({ type: 'error', message: error?.name === 'WalletSignMessageError' ? 'Подключение отклонено в кошельке' : 'Не удалось подключить кошелёк' })
    } finally { setBusy(false) }
  }

  const address = publicKey?.toBase58()
  const label = connected && address ? `${address.slice(0, 4)}…${address.slice(-4)}` : 'Connect Wallet'
  return (
    <motion.button className={`wallet-button wallet-connect ${connected ? 'wallet-connected' : ''}`} onClick={handleClick} disabled={busy} whileHover={{ scale: 1.025 }} whileTap={{ scale: 0.97 }}>
      <Wallet size={15} />
      <span>{busy ? 'Подключаем…' : label}</span>
      {connected && <span className="wallet-balance">{balance === null ? '…' : `${balance.toFixed(3)} SOL`}</span>}
    </motion.button>
  )
}

function Topbar({ page, setPage, onToast }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const items = [
    { id: 'home', label: 'Главная' },
    { id: 'create', label: 'Создать подарок' },
    { id: 'claim', label: 'Получить' },
  ]

  function navigate(id) {
    setPage(id)
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <header className="topbar">
      <button className="brand" onClick={() => navigate('home')} aria-label="solgift — главная">
        <span className="brand-icon"><Gift size={18} strokeWidth={2.2} /></span>
        <span>sol<span className="brand-light">gift</span><span className="brand-dot">.</span></span>
      </button>

      <nav className={`nav-links ${menuOpen ? 'nav-open' : ''}`} aria-label="Основная навигация">
        {items.map((item) => (
          <button key={item.id} className={`nav-link ${page === item.id ? 'nav-link-active' : ''}`} onClick={() => navigate(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <span className="network-pill"><span className="live-dot" /> Solana {import.meta.env.VITE_SOLANA_NETWORK || 'devnet'}</span>
        <WalletConnection onToast={onToast} />
        <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Открыть меню">
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
    </header>
  )
}

function FloatingVoucher({ voucher }) {
  const pointerX = useMotionValue(0)
  const pointerY = useMotionValue(0)
  const smoothX = useSpring(pointerX, { stiffness: 140, damping: 18 })
  const smoothY = useSpring(pointerY, { stiffness: 140, damping: 18 })
  const rotateY = useTransform(smoothX, [-0.5, 0.5], [-11, 11])
  const rotateX = useTransform(smoothY, [-0.5, 0.5], [9, -9])

  function handleMove(event) {
    const bounds = event.currentTarget.getBoundingClientRect()
    pointerX.set((event.clientX - bounds.left) / bounds.width - 0.5)
    pointerY.set((event.clientY - bounds.top) / bounds.height - 0.5)
  }

  function handleLeave() {
    pointerX.set(0)
    pointerY.set(0)
  }

  return (
    <div className="hero-art" onMouseMove={handleMove} onMouseLeave={handleLeave}>
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <motion.div className="hero-card-shell" style={{ rotateX, rotateY }}>
        <motion.div className="hero-card" whileHover={{ rotateY: 180 }} transition={{ duration: 0.65, ease: [0.2, 0.8, 0.2, 1] }}>
          <div className={`voucher-face voucher-front card-${voucher.template.style}`}>
            <div className="voucher-topline"><span>ПОДАРОЧНАЯ ОТКРЫТКА</span><span className="voucher-sparkle"><Sparkles size={15} /></span></div>
            <div className="voucher-artwork">
              <div className="art-glow" />
              <div className="gift-orb"><span>{voucher.template.emoji}</span></div>
              <span className="orb-star star-one">✳</span><span className="orb-star star-two">✦</span><span className="orb-star star-three">·</span>
              <div className="orbit-line orbit-line-a" /><div className="orbit-line orbit-line-b" />
            </div>
            <div className="voucher-bottomline">
              <div><span className="voucher-eyebrow">ДЛЯ ТЕБЯ</span><h3>{voucher.template.title}</h3></div>
              <div className="voucher-amount"><span>{voucher.amount || '0.25'}</span><small>{voucher.currency}</small></div>
            </div>
            <span className="card-corner-glow" />
          </div>
          <div className="voucher-face voucher-back">
            <div className="back-ring"><Gift size={26} /></div>
            <span className="voucher-eyebrow">A LITTLE SOMETHING, ON-CHAIN</span>
            <p>Подарок, который<br /><em>всегда с тобой.</em></p>
            <div className="back-divider" />
            <span className="back-micro">ОДНА ССЫЛКА · БЕЗ ГРАНИЦ</span>
          </div>
        </motion.div>
      </motion.div>
      <motion.div className="floating-chip chip-sol" animate={{ y: [0, -8, 0], rotate: [0, 2, 0] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}>
        <SolMark small /><span>Built on Solana</span>
      </motion.div>
      <motion.div className="floating-chip chip-secure" animate={{ y: [0, 7, 0] }} transition={{ duration: 4.6, repeat: Infinity, ease: 'easeInOut' }}>
        <LockKeyhole size={14} /><span>Твой ключ — твой подарок</span>
      </motion.div>
      <div className="hero-art-caption">Уже готово к отправке <span>↗</span></div>
    </div>
  )
}

function HomePage({ voucher, onCreate, onClaim }) {
  return (
    <motion.main className="page home-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <section className="hero-section">
        <div className="hero-copy">
          <motion.div className="eyebrow-pill" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            <span className="eyebrow-icon"><Sparkles size={13} /></span> WEB3-ПОДАРКИ, ПО-НОВОМУ
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16, duration: 0.65 }}>
            Подари крипту<br /><span className="gradient-text">красиво.</span>
          </motion.h1>
          <motion.p className="hero-subtitle" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
            Создавай анимированные крипто-открытки с SOL или USDC внутри и отправляй друзьям по одной ссылке.
          </motion.p>
          <motion.div className="hero-actions" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.34 }}>
            <Button onClick={onCreate} className="hero-create-btn">Создать подарок <ArrowRight className="button-arrow" size={17} /></Button>
            <button className="text-action" onClick={onClaim}>Посмотреть получение <ArrowDown size={15} /></button>
          </motion.div>
          <motion.div className="hero-proof" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.48 }}>
            <div className="proof-avatars"><span>✦</span><span>◉</span><span>✳</span><span>+</span></div>
            <span>Подарок за <strong>30 секунд</strong></span><span className="proof-separator">·</span><span>Без сложностей</span>
          </motion.div>
        </div>
        <FloatingVoucher voucher={voucher} />
      </section>

      <motion.section className="how-strip" initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.35 }} transition={{ duration: 0.55 }}>
        <div className="how-intro"><span className="section-kicker">ТАК ПРОСТО</span><h2>Три шага.<br /><span className="muted-heading">Один вау-момент.</span></h2></div>
        <div className="step-card"><span className="step-number">01</span><div className="step-icon step-icon-purple"><Sparkles size={18} /></div><h3>Собери открытку</h3><p>Выбери дизайн, токен и сумму — добавь пару тёплых слов.</p></div>
        <div className="step-card"><span className="step-number">02</span><div className="step-icon step-icon-green"><ArrowUpRight size={18} /></div><h3>Отправь ссылку</h3><p>Поделись в мессенджере. Никаких адресов и сложных действий.</p></div>
        <div className="step-card"><span className="step-number">03</span><div className="step-icon step-icon-blue"><Gift size={18} /></div><h3>Пусть откроют</h3><p>Получатель нажимает на конверт — и забирает подарок себе.</p></div>
      </motion.section>

      <motion.section className="home-bottom-cta" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }}>
        <div><span className="section-kicker">МАЛЕНЬКИЙ ЖЕСТ. БОЛЬШОЕ ЧУВСТВО.</span><h2>Самое время<br /><span className="gradient-text">кого-то порадовать.</span></h2></div>
        <Button onClick={onCreate}>Собрать открытку <ArrowRight className="button-arrow" size={17} /></Button>
        <div className="cta-glow" />
      </motion.section>
    </motion.main>
  )
}

function CreatePage({ voucher, setVoucher, onGenerated, onToast }) {
  const [isApiLoading, setIsApiLoading] = useState(false)
  const [secretWord, setSecretWord] = useState('')
  const [secretWordConfirm, setSecretWordConfirm] = useState('')
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  function update(key, value) { setVoucher((current) => ({ ...current, [key]: value })) }

  function generate() {
    if (isApiLoading) return
    void fundVoucher()
  }

  async function fundVoucher() {
    if (!publicKey) {
      onToast({ type: 'error', message: 'Сначала подключи кошелёк Phantom' })
      return
    }
    if (!VOUCHER_API) {
      onToast({ type: 'error', message: 'Эскроу API не настроен — перевод не отправлялся' })
      return
    }
    if ((import.meta.env.VITE_SOLANA_NETWORK || 'devnet') !== 'devnet') {
      onToast({ type: 'error', message: 'Контракт подарков сейчас работает только в Devnet' })
      return
    }
    if ([...secretWord.trim()].length < 12 || secretWord !== secretWordConfirm) {
      onToast({ type: 'error', message: secretWord !== secretWordConfirm ? 'Секретные фразы не совпадают' : 'Задай секретную фразу длиной не менее 12 символов' })
      return
    }
    setIsApiLoading(true)
    let signature
    try {
      onToast({ type: 'sent', message: 'Загрузка... Подготавливаем escrow' })
      const preparation = await voucherApi('/api/escrow/prepare', {
        senderAddress: publicKey.toBase58(), currency: voucher.currency,
        amount: Number(voucher.amount), templateId: voucher.template.id, message: voucher.message,
        secretWord, onchain: true,
      })
      if (!preparation.escrowAddress || !preparation.giftHash || !preparation.voucherId) {
        throw new Error('API не подготовил on-chain подарок; средства не отправлены')
      }
      const transaction = new Transaction()
      const decimals = voucher.currency === 'SOL' ? 9 : 6
      const amount = BigInt(Math.round(Number(voucher.amount) * 10 ** decimals))
      if (amount <= 0n) throw new Error('Укажи корректную сумму подарка')
      transaction.add(await createGiftInstruction({
        creator: publicKey, giftAddress: preparation.escrowAddress,
        giftHash: decodeBase64Url(preparation.giftHash), currency: voucher.currency,
        amount, expiresAt: preparation.expiresAt,
      }))
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      transaction.feePayer = publicKey
      transaction.recentBlockhash = blockhash
      const simulation = await connection.simulateTransaction(transaction)
      if (simulation.value.err) {
        console.error('Voucher funding simulation failed', simulation.value.err, simulation.value.logs)
        const details = simulation.value.logs?.slice(-3).join(' ')
        throw new Error(`Предварительная проверка транзакции не прошла; средства не отправлялись.${details ? ` ${details}` : ''}`)
      }
      signature = await sendTransaction(transaction, connection, { preflightCommitment: 'confirmed' })
      onToast({ type: 'sent', message: 'Транзакция отправлена' })
      await confirmSubmittedTransaction(connection, { signature, blockhash, lastValidBlockHeight })
      onToast({ type: 'sent', message: 'Загрузка... Регистрируем ваучер' })
      let createdVoucher
      try {
        createdVoucher = await voucherApi('/api/escrow/create', {
          senderAddress: publicKey.toBase58(), amount: Number(voucher.amount),
          currency: voucher.currency, templateId: voucher.template.id,
          message: voucher.message, txHash: signature,
        })
      } catch {
        throw new Error(`Перевод подтверждён, но API не зарегистрировал ваучер. Сохрани подпись: ${signature}`)
      }
      const voucherId = createdVoucher.voucherId || preparation.voucherId
      if (!voucherId) throw new Error(`Подарок создан on-chain, но API не вернул ID. Подпись: ${signature}`)
      const link = new URL(window.location.href)
      link.search = ''
      link.searchParams.set('id', voucherId)
      const next = { ...voucher, link: link.toString(), voucherId, signature, status: 'active' }
      setVoucher(next)
      onGenerated(next, secretWord)
      onToast({ type: 'success', message: 'Ваучер создан' })
    } catch (error) {
      console.error('Voucher funding failed', error)
      const rejected = /reject|declin|cancel/i.test(`${error?.name} ${error?.message}`)
      const message = rejected ? 'Транзакция отклонена пользователем' : `Не удалось завершить создание подарка: ${error?.message || 'ошибка сети'}${signature ? ` Подпись: ${signature}` : ''}`
      onToast({ type: 'error', message })
    } finally {
      setIsApiLoading(false)
    }
  }

  return (
    <motion.main className="page create-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <div className="page-heading">
        <span className="section-kicker"><span className="live-dot" /> GIFT STUDIO</span>
        <h1>Создай момент.</h1>
        <p>Подарок начинается с одного простого выбора.</p>
      </div>
      <div className="creator-layout">
        <section className="creator-form glass-panel">
          <div className="form-section">
            <div className="form-heading"><span className="form-step">01</span><div><h2>Выбери настроение</h2><p>Какой повод у вашего подарка?</p></div></div>
            <div className="template-grid">
              {templates.map((template, index) => (
                <motion.button key={template.id} onClick={() => update('template', template)} className={`template-card template-${template.style} ${voucher.template.id === template.id ? 'template-selected' : ''}`} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }}>
                  <span className="template-art"><span className="template-orb">{template.emoji}</span><span className="template-tag">{template.tag}</span></span>
                  <span className="template-name">{template.title}</span>
                  <span className="template-check">{voucher.template.id === template.id && <Check size={12} />}</span>
                  {index === 0 && <span className="popular-badge">ПОПУЛЯРНОЕ</span>}
                </motion.button>
              ))}
            </div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">02</span><div><h2>Добавь ценность</h2><p>Выбери токен и сумму подарка.</p></div></div>
            <div className="field-label-row"><label>Валюта подарка</label><span className="field-note"><ShieldCheck size={13} /> Комиссия сети оплачивается отдельно</span></div>
            <div className="currency-switch" role="group" aria-label="Валюта подарка">
              {['SOL', 'USDC'].map((coin) => (
                <button key={coin} className={`currency-option ${voucher.currency === coin ? 'currency-selected' : ''}`} onClick={() => update('currency', coin)}>
                  {coin === 'SOL' ? <SolMark small /> : <span className="usdc-mark">$</span>}
                  <span>{coin}</span><small>{coin === 'SOL' ? 'Solana' : 'USD Coin'}</small>
                  {voucher.currency === coin && <span className="currency-check"><Check size={11} /></span>}
                </button>
              ))}
            </div>
            <label className="input-label" htmlFor="gift-amount">Сумма</label>
            <div className="amount-input-wrap"><input id="gift-amount" type="number" min="0.01" step={voucher.currency === 'SOL' ? '0.01' : '1'} value={voucher.amount} onChange={(event) => update('amount', event.target.value)} placeholder="0.25"/><span className="amount-unit">{voucher.currency}</span><ChevronDown size={15} /></div>
            <div className="amount-hint"><span>Минимальная сумма</span><span>{voucher.currency === 'SOL' ? '0.01 SOL' : '1 USDC'}</span></div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">03</span><div><h2>Добавь пару слов</h2><p>Тёплое сообщение сделает подарок личным.</p></div></div>
            <label className="input-label" htmlFor="gift-message">Сообщение получателю <span>НЕОБЯЗАТЕЛЬНО</span></label>
            <textarea id="gift-message" maxLength={120} value={voucher.message} onChange={(event) => update('message', event.target.value)} placeholder="Напиши что-то доброе..." />
            <div className="amount-hint message-hint"><span>Только добрые слова, пожалуйста</span><span>{voucher.message.length}/120</span></div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">04</span><div><h2>Защити подарок</h2><p>Получателю понадобятся ссылка и секретная фраза.</p></div></div>
            <label className="input-label" htmlFor="gift-secret-word">Секретная фраза</label>
            <div className="amount-input-wrap secret-word-input-wrap"><input id="gift-secret-word" type="password" autoComplete="off" maxLength={256} value={secretWord} onChange={(event) => setSecretWord(event.target.value)} placeholder="Например, три слова" /></div>
            <label className="input-label secret-word-confirm-label" htmlFor="gift-secret-word-confirm">Повтори фразу</label>
            <div className="amount-input-wrap secret-word-input-wrap"><input id="gift-secret-word-confirm" type="password" autoComplete="new-password" maxLength={256} value={secretWordConfirm} onChange={(event) => setSecretWordConfirm(event.target.value)} placeholder="Повтори секретную фразу" /></div>
            <div className="amount-hint"><span>Минимум 12 символов; лучше несколько слов</span></div>
            <p className="secret-word-note">Не добавляй фразу в ссылку. Передай её получателю отдельно.</p>
          </div>

          <div className="form-footer">
            <div className="secure-note"><LockKeyhole size={14} /><span>Приватный ключ остаётся у тебя</span></div>
            <Button onClick={generate} className="generate-button" disabled={isApiLoading || !Number(voucher.amount) || Number(voucher.amount) <= 0 || [...secretWord.trim()].length < 12 || secretWord !== secretWordConfirm}>
              {isApiLoading ? <><span className="spinner" /> Создаём открытку...</> : <>Сгенерировать ссылку <ArrowRight size={16} className="button-arrow" /></>}
            </Button>
          </div>
        </section>

        <aside className="preview-column">
          <div className="preview-sticky">
            <div className="preview-caption"><span className="section-kicker">LIVE PREVIEW</span><span><span className="live-dot" /> ОБНОВЛЯЕТСЯ</span></div>
            <div className={`preview-card card-${voucher.template.style}`}>
              <div className="preview-card-top"><span>ПОДАРОЧНАЯ ОТКРЫТКА</span><Sparkles size={14} /></div>
              <div className="preview-center"><div className="preview-circle"><span>{voucher.template.emoji}</span><i>✦</i><b>✳</b></div></div>
              <div className="preview-card-bottom"><div><span className="voucher-eyebrow">{voucher.template.tag}</span><h3>{voucher.template.title}</h3></div><div className="preview-amount"><span>{voucher.amount || '0.00'}</span><small>{voucher.currency}</small></div></div>
            </div>
            <motion.div className="preview-summary" layout>
              <span><span className="summary-token">{voucher.currency === 'SOL' ? <SolMark small /> : <span className="usdc-mark mini">$</span>}</span>Подарок получателю</span>
              <strong>{formatAmount(voucher.amount, voucher.currency)}</strong>
            </motion.div>
            <div className="preview-note"><div className="note-icon"><Zap size={14} /></div><p><strong>Момент открытия — твой.</strong><br />Получатель узнает, что внутри, только когда откроет ссылку.</p></div>
            <div className="preview-card-foot"><span>POWERED BY SOLANA</span><span>01 — 04</span></div>
          </div>
        </aside>
      </div>
    </motion.main>
  )
}

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 32 }, (_, index) => ({
    id: index,
    x: `${(Math.random() - 0.5) * 440}px`,
    y: `${-60 - Math.random() * 270}px`,
    rotation: `${Math.random() * 560 - 280}deg`,
    delay: Math.random() * 0.3,
    color: ['#14f195', '#9945ff', '#61e7ff', '#ffd166', '#ffffff'][index % 5],
  })), [])

  return <div className="confetti-layer" aria-hidden="true">{pieces.map((piece) => <motion.i key={piece.id} style={{ background: piece.color }} initial={{ opacity: 0, x: 0, y: 0, rotate: 0, scale: 0.3 }} animate={{ opacity: [0, 1, 1, 0], x: piece.x, y: piece.y, rotate: piece.rotation, scale: [0.3, 1, 0.7] }} transition={{ duration: 1.65, delay: piece.delay, ease: 'easeOut' }} />)}</div>
}

function ClaimPage({ voucher, onToast, isVoucherLoading = false }) {
  const [opened, setOpened] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [isApiLoading, setIsApiLoading] = useState(false)
  const [secretWord, setSecretWord] = useState('')
  useEffect(() => { if (voucher.status === 'claimed') setClaimed(true) }, [voucher.status])
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  const isExpired = voucher.status === 'expired' || (voucher.expiresAt && Date.now() >= voucher.expiresAt * 1000)
  const isUnavailable = claimed || voucher.status === 'claimed' || voucher.status === 'refunded' || isExpired

  function openGift() {
    if (!opened) setOpened(true)
  }

  async function claimGift() {
    if (!publicKey) {
      onToast({ type: 'error', message: 'Подключи кошелёк получателя перед получением' })
      return
    }
    if (!voucher.voucherId || !VOUCHER_API) {
      onToast({ type: 'error', message: 'Ссылка не связана с эскроу-сервисом; запрос не отправлен' })
      return
    }
    if ([...secretWord.trim()].length < 12) {
      onToast({ type: 'error', message: 'Введи секретную фразу, которую тебе передал отправитель' })
      return
    }
    if (isApiLoading || isUnavailable) return
    setIsApiLoading(true)
    try {
      onToast({ type: 'sent', message: 'Загрузка... Запрашиваем выплату' })
      const result = await voucherApi('/api/escrow/claim', {
        voucherId: voucher.voucherId, recipientAddress: publicKey.toBase58(), secretWord,
      })
      let txHash
      let confirmation
      if (result.onchain) {
        if (!voucher.onchain || !voucher.giftAddress || !voucher.giftHash || !voucher.senderAddress || !result.giftSecret) {
          throw new Error('Не удалось проверить данные on-chain подарка')
        }
        const transaction = new Transaction()
        transaction.add(await claimGiftInstruction({
          creator: voucher.senderAddress, giftAddress: voucher.giftAddress,
          giftHash: decodeBase64Url(voucher.giftHash), giftSecret: decodeBase64Url(result.giftSecret),
          currency: voucher.currency, recipient: publicKey,
        }))
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        transaction.feePayer = publicKey
        transaction.recentBlockhash = blockhash
        const simulation = await connection.simulateTransaction(transaction)
        if (simulation.value.err) {
          const details = simulation.value.logs?.slice(-3).join(' ')
          throw new Error(`Предварительная проверка получения не прошла.${details ? ` ${details}` : ''}`)
        }
        onToast({ type: 'sent', message: 'Подтверди получение подарка в кошельке' })
        txHash = await sendTransaction(transaction, connection, { preflightCommitment: 'confirmed' })
        onToast({ type: 'sent', message: 'Транзакция отправлена, ожидаем подтверждение' })
        confirmation = await confirmSubmittedTransaction(connection, { signature: txHash, blockhash, lastValidBlockHeight })
      } else {
        txHash = result.txHash || result.signature
        if (!txHash) throw new Error('Эскроу API не вернул хэш транзакции выплаты')
        onToast({ type: 'sent', message: 'Выплата отправлена, ожидаем подтверждение' })
        confirmation = result.blockhash && result.lastValidBlockHeight
          ? await confirmSubmittedTransaction(connection, { signature: txHash, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight })
          : await confirmSubmittedTransaction(connection, txHash)
      }
      if (confirmation.value.err) throw new Error('Ошибка сети при подтверждении выплаты')
      setClaimed(true)
      onToast({ type: 'success', message: 'Успешно выплачено' })
    } catch (error) {
      console.error('Voucher claim failed', error)
      const rejected = /reject|declin|cancel/i.test(`${error?.name} ${error?.message}`)
      const message = /secret word is incorrect/i.test(error?.message || '') ? 'Секретная фраза неверна'
        : /too many secret-word attempts/i.test(error?.message || '') ? 'Слишком много попыток. Попробуй через 15 минут'
          : /predates secret-word/i.test(error?.message || '') ? 'Этот ваучер создан до защиты фразой; попроси отправителя создать новый'
            : `Ошибка получения: ${error?.message || 'Сервис недоступен'}`
      onToast({ type: 'error', message: rejected ? 'Транзакция отклонена пользователем' : message })
    } finally { setIsApiLoading(false) }
  }

  return (
    <motion.main className="page claim-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <div className="claim-topline"><span className="section-kicker">A LITTLE SOMETHING FOR YOU</span><span className="demo-tag"><span className="live-dot" /> {voucher.voucherId ? 'SOLANA VOUCHER' : 'ПРЕДПРОСМОТР'}</span></div>
      <section className={`claim-scene ${opened ? 'claim-opened' : ''}`}>
        <div className="claim-halo" />
        <AnimatePresence>{claimed && <Confetti key="confetti" />}</AnimatePresence>
        {!opened ? (
          <motion.div className="envelope-wrap" initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.55, type: 'spring', bounce: 0.24 }}>
            <motion.div className="envelope-orbit" animate={{ rotate: 360 }} transition={{ duration: 34, repeat: Infinity, ease: 'linear' }} />
            <motion.button className="gift-envelope" onClick={openGift} aria-label="Открыть подарок" whileHover={{ scale: 1.045, rotate: -1.5 }} whileTap={{ scale: 0.96 }} animate={{ y: [0, -9, 0] }} transition={{ y: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' } }}>
              <div className="envelope-card-back"><span>FOR YOU</span><i>✦</i></div>
              <div className="envelope-body"><div className="envelope-flap" /><div className="envelope-seal"><Gift size={27} /><span>✳</span></div><div className="envelope-fold-left"/><div className="envelope-fold-right"/></div>
              <span className="envelope-glint" />
            </motion.button>
            <motion.div className="envelope-label" animate={{ opacity: [0.6, 1, 0.6] }} transition={{ duration: 2.2, repeat: Infinity }}>ТЕБЕ ПРИШЁЛ ПОДАРОК</motion.div>
          </motion.div>
        ) : (
          <motion.div className="revealed-card" initial={{ opacity: 0, scale: 0.72, y: 28, rotateX: -14 }} animate={{ opacity: 1, scale: 1, y: 0, rotateX: 0 }} transition={{ duration: 0.72, type: 'spring', bounce: 0.2 }}>
            <div className={`revealed-art card-${voucher.template.style}`}><span className="revealed-emoji">{voucher.template.emoji}</span><span className="revealed-art-spark">✦</span><span className="revealed-art-dot">✳</span></div>
            <span className="voucher-eyebrow">ТВОЙ ПОДАРОК</span>
            <motion.div className="revealed-amount" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.18, type: 'spring' }}>
              <strong>{formatAmount(voucher.amount, voucher.currency).split(' ')[0]}</strong>
              <span>{voucher.currency === 'SOL' ? <SolMark small /> : <span className="usdc-mark mini">$</span>}{voucher.currency}</span>
            </motion.div>
            <h1>{voucher.template.title}</h1>
            <p className="revealed-message">“{voucher.message || 'Небольшой сюрприз специально для тебя ✨'}”</p>
            <div className="revealed-from"><span className="from-avatar">✳</span><span>С теплом, <strong>твой друг</strong></span><span className="from-dot">·</span><span className="onchain-label"><SolMark small /> on-chain</span></div>
            {!isUnavailable && <div className="claim-secret-field"><label className="input-label" htmlFor="claim-secret-word">Секретная фраза</label><div className="amount-input-wrap secret-word-input-wrap"><input id="claim-secret-word" type="password" autoComplete="off" maxLength={256} value={secretWord} onChange={(event) => setSecretWord(event.target.value)} placeholder="Введи фразу от отправителя" /></div></div>}
            <Button onClick={claimGift} className={`claim-button ${claimed || voucher.status === 'claimed' ? 'claim-button-done' : ''}`} disabled={isVoucherLoading || isApiLoading || isUnavailable || [...secretWord.trim()].length < 12}>
              {claimed || voucher.status === 'claimed' ? <><Check size={17} /> Подарок получен</> : isExpired || voucher.status === 'refunded' ? <>Срок получения истёк</> : isApiLoading ? <><span className="spinner" /> Отправляем…</> : <>Забрать на кошелёк <ArrowRight className="button-arrow" size={17} /></>}
            </Button>
            <span className="claim-footnote"><LockKeyhole size={12} /> {publicKey ? 'Перевод из смарт-контракта после подписи' : 'Сначала подключи кошелёк получателя'}</span>
          </motion.div>
        )}
      </section>
      {!opened && <div className="claim-instructions"><span>01</span><p>Нажми на конверт,<br />чтобы открыть сюрприз</p></div>}
      <div className="claim-bottom-note"><span>SECURED BY SOLANA</span><span>Никаких скрытых условий. Только подарок.</span><span>✳</span></div>
    </motion.main>
  )
}

function LinkModal({ voucher, onClose, onClaim }) {
  const [copied, setCopied] = useState(false)
  const [copiedSecret, setCopiedSecret] = useState(false)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(voucher.link)
    } catch {
      const text = document.createElement('textarea')
      text.value = voucher.link
      text.style.position = 'fixed'
      text.style.opacity = '0'
      document.body.appendChild(text)
      text.select()
      document.execCommand('copy')
      text.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2200)
  }

  async function copySecretWord() {
    try {
      await navigator.clipboard.writeText(voucher.secretWord)
      setCopiedSecret(true)
      window.setTimeout(() => setCopiedSecret(false), 2200)
    } catch {
      const text = document.createElement('textarea')
      text.value = voucher.secretWord
      text.style.position = 'fixed'
      text.style.opacity = '0'
      document.body.appendChild(text)
      text.select()
      document.execCommand('copy')
      text.remove()
      setCopiedSecret(true)
      window.setTimeout(() => setCopiedSecret(false), 2200)
    }
  }

  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="link-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="link-modal-title" initial={{ opacity: 0, y: 24, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.97 }} transition={{ type: 'spring', duration: 0.45 }} onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть"><X size={17} /></button>
        <div className="modal-success"><div className="modal-success-ring"><Check size={23} /></div><span className="success-ray ray-a"/><span className="success-ray ray-b"/></div>
        <span className="section-kicker">ВОТ ЭТО ДА!</span>
        <h2 id="link-modal-title">Твой подарок<br /><span className="gradient-text">уже готов.</span></h2>
        <p className="modal-description">Отправь другу ссылку, а секретную фразу передай отдельно.</p>
        <div className="link-copy-field"><span>{voucher.link}</span><button onClick={copyLink} aria-label="Скопировать ссылку">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
        <Button onClick={copyLink} className="modal-copy-button">{copied ? <><Check size={16} /> Скопировано</> : <>Скопировать ссылку <ArrowRight size={16} className="button-arrow" /></>}</Button>
        <div className="secret-share-card"><div><span className="section-kicker">ПЕРЕДАЙ ОТДЕЛЬНО ОТ ССЫЛКИ</span><strong>{voucher.secretWord}</strong></div><button onClick={copySecretWord} aria-label="Скопировать секретную фразу">{copiedSecret ? <Check size={15} /> : <Copy size={15} />}</button></div>
        <p className="secret-share-note">Тот, у кого есть и ссылка, и фраза, сможет получить подарок.</p>
        <button className="see-claim-link" onClick={onClaim}>Открыть экран получателя <ArrowUpRight size={14} /></button>
        <div className="modal-bottom"><LockKeyhole size={12} /> ВАУЧЕР SOLANA · ССЫЛКА НЕ СОДЕРЖИТ СЕКРЕТНУЮ ФРАЗУ</div>
      </motion.div>
    </motion.div>
  )
}

function StatusToast({ toast }) {
  const icon = toast.type === 'success' ? <Check size={16} /> : toast.type === 'sent' ? <ArrowUpRight size={16} /> : <X size={16} />
  return (
    <motion.div className={`toast-message toast-${toast.type}`} role="status" initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 9, scale: 0.98 }}>
      {icon}<span>{toast.message}</span>
    </motion.div>
  )
}

function App() {
  const params = new URLSearchParams(window.location.search)
  const requestedVoucherId = params.get('id') || params.get('voucher')
  const initialVoucherId = requestedVoucherId && /^[A-Za-z0-9_-]{1,128}$/.test(requestedVoucherId) ? requestedVoucherId : null
  const [page, setPage] = useState(initialVoucherId ? 'claim' : 'home')
  const [voucher, setVoucher] = useState(initialVoucher)
  const [deliverySecretWord, setDeliverySecretWord] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [isApiLoading, setIsApiLoading] = useState(false)

  useEffect(() => {
    if (requestedVoucherId && !initialVoucherId) {
      setToast({ type: 'error', message: 'Ошибка API: некорректный ID ваучера' })
      return
    }
    if (!initialVoucherId) return
    if (!VOUCHER_API) {
      setToast({ type: 'error', message: 'Ошибка API: сервис ваучеров не настроен' })
      return
    }
    let active = true
    setIsApiLoading(true)
    setToast({ type: 'sent', message: 'Загрузка... Проверяем ваучер' })
    const query = new URLSearchParams({ id: initialVoucherId })
    voucherApi(`/api/escrow/details?${query.toString()}`)
      .then((result) => {
        const data = result.voucher || result
        const templateId = data.templateId || data.template
        const template = templates.find((item) => item.id === templateId) || templates[0]
        const status = ['claimed', 'refunded', 'expired'].includes(data.status) ? data.status : 'active'
        if (active) {
          setVoucher((current) => ({ ...current, ...data, template, voucherId: initialVoucherId, status }))
          setToast(null)
        }
      })
      .catch((error) => { if (active) setToast({ type: 'error', message: `Ошибка API: ${error.message || 'Ваучер не найден'}` }) })
      .finally(() => { if (active) setIsApiLoading(false) })
    return () => { active = false }
  }, [initialVoucherId, requestedVoucherId])

  function notify(nextToast) {
    setToast(nextToast)
    window.clearTimeout(notify.timeout)
    if (nextToast.type !== 'sent') notify.timeout = window.setTimeout(() => setToast(null), 4200)
  }

  function navigate(id) {
    setModalOpen(false)
    if (id !== 'create') setDeliverySecretWord('')
    setPage(id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-purple" /><div className="ambient ambient-green" />
      <div className="noise-overlay" />
      <Topbar page={page} setPage={navigate} onToast={notify} />
      <AnimatePresence mode="wait">
        {page === 'home' && <HomePage key="home" voucher={voucher} onCreate={() => navigate('create')} onClaim={() => navigate('claim')} />}
        {page === 'create' && <CreatePage key="create" voucher={voucher} setVoucher={setVoucher} onToast={notify} onGenerated={(next, phrase) => { setVoucher(next); setDeliverySecretWord(phrase); setModalOpen(true) }} />}
        {page === 'claim' && <ClaimPage key={`claim-${voucher.voucherId || voucher.link}`} voucher={voucher} onToast={notify} isVoucherLoading={isApiLoading} />}
      </AnimatePresence>
      <footer className="site-footer"><button className="footer-brand" onClick={() => navigate('home')}><span className="brand-icon small-brand-icon"><Gift size={13} /></span> solgift<span className="brand-dot">.</span></button><span>Маленькие жесты. Большая энергия.</span><span className="footer-right">MADE WITH <span>✳</span> ON SOLANA</span></footer>
      <AnimatePresence>{toast && <StatusToast key={`${toast.type}-${toast.message}`} toast={toast} />}</AnimatePresence>
      <AnimatePresence>{modalOpen && <LinkModal voucher={{ ...voucher, secretWord: deliverySecretWord }} onClose={() => { setModalOpen(false); setDeliverySecretWord('') }} onClaim={() => navigate('claim')} />}</AnimatePresence>
    </div>
  )
}

export default App
