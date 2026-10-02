import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { createGiftInstruction, decodeBase64Url, SOLGIFT_PROGRAM_ID, USDC_DEVNET_MINT } from './solgift-program.js'
import { SOLGIFT_PROGRAM_ABI } from '../shared/solgift-program-config.js'
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, Gift,
  LockKeyhole, Menu, ShieldCheck, Sparkles, Wallet, X, Zap,
} from 'lucide-react'

const VOUCHER_API = import.meta.env.PROD
  ? window.location.origin
  : import.meta.env.VITE_VOUCHER_API_URL || ''

async function voucherApi(path, body) {
  if (!VOUCHER_API) throw new Error('Voucher service is not configured. Please try again later.')
  const response = await fetch(`${VOUCHER_API.replace(/\/$/, '')}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.status === 'error') {
    const error = new Error(result.message || result.error || `Service error (${response.status})`)
    error.status = response.status
    throw error
  }
  return result
}

async function confirmSubmittedTransaction(connection, strategy) {
  const signature = typeof strategy === 'string' ? strategy : strategy.signature
  try {
    const confirmation = await connection.confirmTransaction(strategy, 'confirmed')
    if (confirmation.value.err) throw new Error('The Solana transaction failed')
    return confirmation
  } catch (error) {
    // A blockhash-expiry timeout can race with confirmation reaching the RPC.
    // Check transaction history before telling the user that an already landed
    // payment failed; this also lets the caller continue with API registration.
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    if (status?.err) throw new Error('The Solana transaction failed')
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { value: { err: null } }

    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    })
    if (transaction?.meta?.err) throw new Error('The Solana transaction failed')
    if (transaction) return { value: { err: null } }

    if (error?.name === 'TransactionExpiredBlockheightExceededError') {
      throw new Error('Transaction confirmation timed out and it has not appeared in Solana history yet. Save the signature and check it on Solscan Devnet.')
    }
    throw error
  }
}

const templates = [
  { id: 'birthday', title: 'Happy Birthday', emoji: '🎂', tag: 'CELEBRATE', style: 'birthday' },
  { id: 'coffee', title: 'Coffee Treat', emoji: '☕', tag: 'LITTLE TREAT', style: 'coffee' },
  { id: 'thanks', title: 'Thank You!', emoji: '✳', tag: 'JUST BECAUSE', style: 'thanks' },
  { id: 'study', title: 'Good Luck', emoji: '📚', tag: 'GOOD LUCK', style: 'study' },
]

const initialVoucher = {
  template: templates[0],
  currency: 'SOL',
  amount: '0.25',
  message: 'May this year shine bright ✨',
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
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: currency === 'SOL' ? 4 : 2 }).format(number)} ${currency}`
}

function tokenAmount(transaction, address, mint, phase) {
  return (transaction?.meta?.[`${phase}TokenBalances`] || []).reduce((sum, balance) => {
    if (balance.mint !== mint || balance.owner !== address) return sum
    return sum + Number(balance.uiTokenAmount?.amount || 0) / (10 ** (balance.uiTokenAmount?.decimals || 0))
  }, 0)
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
  const [usdcBalance, setUsdcBalance] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyLoadedAddress, setHistoryLoadedAddress] = useState('')
  const walletMenuRef = useRef(null)

  useEffect(() => {
    let active = true
    if (!connected || !publicKey) {
      setBalance(null)
      setUsdcBalance(null)
      setOpen(false)
      setHistoryOpen(false)
      setHistory([])
      setHistoryError('')
      setHistoryLoadedAddress('')
      return () => { active = false }
    }
    connection.getBalance(publicKey, 'confirmed')
      .then((lamports) => { if (active) setBalance(lamports / LAMPORTS_PER_SOL) })
      .catch(() => { if (active) setBalance(null) })
    connection.getParsedTokenAccountsByOwner(publicKey, { mint: USDC_DEVNET_MINT }, 'confirmed')
      .then(({ value }) => {
        if (!active) return
        const total = value.reduce((sum, account) => sum + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0)
        setUsdcBalance(total)
      })
      .catch(() => { if (active) setUsdcBalance(null) })
    const subscription = connection.onAccountChange(publicKey, (account) => {
      if (active) setBalance(account.lamports / LAMPORTS_PER_SOL)
    }, 'confirmed')
    return () => { active = false; connection.removeAccountChangeListener(subscription) }
  }, [connection, connected, publicKey])

  async function loadHistory(force = false) {
    if (!publicKey || historyLoading) return
    const address = publicKey.toBase58()
    if (!force && historyLoadedAddress === address) return
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 10 }, 'confirmed')
      if (!signatures.length) { setHistory([]); setHistoryLoadedAddress(address); return }
      const transactions = []
      // Public Devnet RPC endpoints rate-limit large JSON-RPC batches. Fetch a
      // few at a time and back off when the endpoint returns HTTP 429.
      for (let offset = 0; offset < signatures.length; offset += 2) {
        const batch = signatures.slice(offset, offset + 2)
        let result
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            result = await connection.getParsedTransactions(
              batch.map(({ signature }) => signature),
              { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
            )
            break
          } catch (error) {
            const rateLimited = /429|too many requests/i.test(error?.message || '')
            if (!rateLimited || attempt === 3) throw error
            await new Promise((resolve) => setTimeout(resolve, 700 * (2 ** attempt)))
          }
        }
        transactions.push(...(result || []))
        if (offset + 2 < signatures.length) await new Promise((resolve) => setTimeout(resolve, 350))
      }
      const rows = transactions.flatMap((transaction, index) => {
        if (!transaction?.meta) return []
        const accountKeys = transaction.transaction.message.accountKeys
        const ownerIndex = accountKeys.findIndex((key) => (key.pubkey || key).toBase58() === address)
        if (ownerIndex < 0) return []
        const solDelta = (transaction.meta.postBalances[ownerIndex] - transaction.meta.preBalances[ownerIndex]) / LAMPORTS_PER_SOL
        const mint = USDC_DEVNET_MINT.toBase58()
        const usdcDelta = tokenAmount(transaction, address, mint, 'post') - tokenAmount(transaction, address, mint, 'pre')
        if (Math.abs(solDelta) < 0.000000001 && Math.abs(usdcDelta) < 0.000001) return []
        return [{ signature: signatures[index].signature, blockTime: transaction.blockTime, solDelta, usdcDelta }]
      })
      setHistory(rows)
      setHistoryLoadedAddress(address)
    } catch (error) {
      setHistoryError(/429|too many requests/i.test(error?.message || '')
        ? 'The Devnet RPC is temporarily rate-limiting requests. Wait a moment and try again.'
        : 'Could not load transaction history. Check your connection and try again.')
    } finally { setHistoryLoading(false) }
  }

  function toggleHistory() {
    const nextOpen = !historyOpen
    setHistoryOpen(nextOpen)
    if (nextOpen) loadHistory()
  }

  useEffect(() => {
    if (!open) return undefined
    function handlePointerDown(event) {
      if (!walletMenuRef.current?.contains(event.target)) setOpen(false)
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  async function handleClick() {
    if (connected) { setOpen((value) => !value); return }
    try {
      setBusy(true)
      if (wallet) await connect()
      else setVisible(true)
    } catch (error) {
      onToast({ type: 'error', message: error?.name === 'WalletSignMessageError' ? 'Wallet connection was rejected' : 'Could not connect wallet' })
    } finally { setBusy(false) }
  }

  async function copyAddress() {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      onToast({ type: 'success', message: 'Wallet address copied' })
    } catch {
      onToast({ type: 'error', message: 'Could not copy address' })
    }
  }

  const address = publicKey?.toBase58()
  const label = connected && address ? `${address.slice(0, 4)}…${address.slice(-4)}` : 'Connect Wallet'
  return (
    <div className="wallet-menu-wrap" ref={walletMenuRef}>
      <motion.button type="button" aria-expanded={connected ? open : undefined} aria-haspopup={connected ? 'dialog' : undefined} className={`wallet-button wallet-connect ${connected ? 'wallet-connected' : ''}`} onClick={handleClick} disabled={busy} whileHover={{ scale: 1.025 }} whileTap={{ scale: 0.97 }}>
        <Wallet size={15} />
        <span>{busy ? 'Connecting…' : label}</span>
        {connected && <span className="wallet-balance">{balance === null ? '…' : `${balance.toFixed(3)} SOL`}</span>}
      </motion.button>
      {connected && open && (
        <section className="wallet-popover" role="dialog" aria-label="Wallet details">
          <div className="wallet-popover-head">
            <div><span className="wallet-popover-kicker">CONNECTED WALLET</span><strong>{wallet?.adapter?.name || 'Solana wallet'}</strong></div>
            <button type="button" className="wallet-popover-close" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="wallet-address-row"><span>{address}</span><button type="button" onClick={copyAddress} aria-label="Copy address" title="Copy address"><Copy size={15} /></button></div>
          <div className="wallet-assets">
            <div><span>SOL</span><strong>{balance === null ? 'Loading…' : `${balance.toFixed(4)} SOL`}</strong></div>
            <div><span>USDC · Devnet</span><strong>{usdcBalance === null ? 'Loading…' : `${usdcBalance.toFixed(2)} USDC`}</strong></div>
          </div>
          <section className="wallet-history" aria-label="Transaction history">
            <div className="wallet-history-heading">
              <strong>Transaction history</strong>
              <button type="button" onClick={toggleHistory} aria-expanded={historyOpen}>{historyOpen ? 'Hide' : 'Show'}</button>
            </div>
            {historyOpen && <>
              {historyLoading && <p className="wallet-history-state">Loading recent confirmed transactions…</p>}
              {historyError && <div className="wallet-history-state wallet-history-error"><span>{historyError}</span><button type="button" onClick={() => loadHistory(true)}>Retry</button></div>}
              {!historyLoading && !historyError && history.length === 0 && <p className="wallet-history-state">No recent SOL or USDC transfers.</p>}
              {!historyLoading && history.length > 0 && (() => {
                const totals = history.reduce((sum, row) => ({
                  solIn: sum.solIn + Math.max(0, row.solDelta), solOut: sum.solOut + Math.max(0, -row.solDelta),
                  usdcIn: sum.usdcIn + Math.max(0, row.usdcDelta), usdcOut: sum.usdcOut + Math.max(0, -row.usdcDelta),
                }), { solIn: 0, solOut: 0, usdcIn: 0, usdcOut: 0 })
                return <>
                  <div className="wallet-history-totals">
                    <div><strong>SOL</strong><span>↓ {totals.solIn.toFixed(6)} received</span><span>↑ {totals.solOut.toFixed(6)} sent</span></div>
                    <div><strong>USDC</strong><span>↓ {totals.usdcIn.toFixed(2)} received</span><span>↑ {totals.usdcOut.toFixed(2)} sent</span></div>
                  </div>
                  <p className="wallet-history-note">Totals for up to 10 recent transactions. SOL outflow includes network fees and rent.</p>
                  <ul className="wallet-history-list">{history.map((row) => {
                    const hasIncoming = row.solDelta > 0 || row.usdcDelta > 0
                    const hasOutgoing = row.solDelta < 0 || row.usdcDelta < 0
                    const direction = hasIncoming && hasOutgoing ? 'Mixed' : hasIncoming ? 'Incoming' : 'Outgoing'
                    const amountLabel = row.solDelta && row.usdcDelta
                      ? `${row.solDelta > 0 ? '+' : ''}${row.solDelta.toFixed(6)} SOL · ${row.usdcDelta > 0 ? '+' : ''}${row.usdcDelta.toFixed(2)} USDC`
                      : row.solDelta ? `${row.solDelta > 0 ? '+' : ''}${row.solDelta.toFixed(6)} SOL` : `${row.usdcDelta > 0 ? '+' : ''}${row.usdcDelta.toFixed(2)} USDC`
                    return <li key={row.signature}>
                      <span className={`wallet-history-direction ${direction === 'Incoming' ? 'is-in' : direction === 'Outgoing' ? 'is-out' : 'is-mixed'}`}>{direction}</span>
                      <span className="wallet-history-entry"><strong>{amountLabel}</strong><small>{row.blockTime ? new Date(row.blockTime * 1000).toLocaleString('en-US') : 'Time unavailable'}</small></span>
                      <a href={`https://solscan.io/tx/${row.signature}?cluster=devnet`} target="_blank" rel="noreferrer" aria-label="Open transaction in Solscan"><ArrowUpRight size={14} /></a>
                    </li>
                  })}</ul>
                </>
              })()}
            </>}
          </section>
          <p className="wallet-account-help">Choose other accounts in your wallet app. Solgift will update the connected address when you switch.</p>
          <div className="wallet-popover-actions">
            <a href={`https://solscan.io/account/${address}?cluster=devnet`} target="_blank" rel="noreferrer">View on Solscan <ArrowUpRight size={14} /></a>
            <button type="button" onClick={async () => { await disconnect(); setOpen(false) }}>Disconnect</button>
          </div>
        </section>
      )}
    </div>
  )
}

function Topbar({ page, setPage, onToast }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const items = [
    { id: 'home', label: 'Home' },
    { id: 'create', label: 'Create a gift' },
    { id: 'claim', label: 'Claim' },
  ]

  function navigate(id) {
    setPage(id)
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <header className="topbar">
      <button className="brand" onClick={() => navigate('home')} aria-label="solgift — home">
        <span className="brand-icon"><Gift size={18} strokeWidth={2.2} /></span>
        <span>sol<span className="brand-light">gift</span><span className="brand-dot">.</span></span>
      </button>

      <nav className={`nav-links ${menuOpen ? 'nav-open' : ''}`} aria-label="Main navigation">
        {items.map((item) => (
          <button key={item.id} className={`nav-link ${page === item.id ? 'nav-link-active' : ''}`} onClick={() => navigate(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <span className="network-pill"><span className="live-dot" /> Solana {import.meta.env.VITE_SOLANA_NETWORK || 'devnet'}</span>
        <WalletConnection onToast={onToast} />
        <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open menu">
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
            <div className="voucher-topline"><span>GIFT CARD</span><span className="voucher-sparkle"><Sparkles size={15} /></span></div>
            <div className="voucher-artwork">
              <div className="art-glow" />
              <div className="gift-orb"><span>{voucher.template.emoji}</span></div>
              <span className="orb-star star-one">✳</span><span className="orb-star star-two">✦</span><span className="orb-star star-three">·</span>
              <div className="orbit-line orbit-line-a" /><div className="orbit-line orbit-line-b" />
            </div>
            <div className="voucher-bottomline">
              <div><span className="voucher-eyebrow">FOR YOU</span><h3>{voucher.template.title}</h3></div>
              <div className="voucher-amount"><span>{voucher.amount || '0.25'}</span><small>{voucher.currency}</small></div>
            </div>
            <span className="card-corner-glow" />
          </div>
          <div className="voucher-face voucher-back">
            <div className="back-ring"><Gift size={26} /></div>
            <span className="voucher-eyebrow">A LITTLE SOMETHING, ON-CHAIN</span>
            <p>A gift that<br /><em>stays with you.</em></p>
            <div className="back-divider" />
            <span className="back-micro">ONE LINK · NO BORDERS</span>
          </div>
        </motion.div>
      </motion.div>
      <motion.div className="floating-chip chip-sol" animate={{ y: [0, -8, 0], rotate: [0, 2, 0] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}>
        <SolMark small /><span>Built on Solana</span>
      </motion.div>
      <motion.div className="floating-chip chip-secure" animate={{ y: [0, 7, 0] }} transition={{ duration: 4.6, repeat: Infinity, ease: 'easeInOut' }}>
        <LockKeyhole size={14} /><span>Your keys, your gift</span>
      </motion.div>
      <div className="hero-art-caption">Ready to send <span>↗</span></div>
    </div>
  )
}

function HomePage({ voucher, onCreate, onClaim }) {
  return (
    <motion.main className="page home-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <section className="hero-section">
        <div className="hero-copy">
          <motion.div className="eyebrow-pill" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            <span className="eyebrow-icon"><Sparkles size={13} /></span> WEB3 GIFTS, REIMAGINED
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16, duration: 0.65 }}>
            Give crypto<br /><span className="gradient-text">beautifully.</span>
          </motion.h1>
          <motion.p className="hero-subtitle" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
            Create animated crypto gift cards with SOL or USDC inside, then share them with friends using one link.
          </motion.p>
          <motion.div className="hero-actions" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.34 }}>
            <Button onClick={onCreate} className="hero-create-btn">Create a gift <ArrowRight className="button-arrow" size={17} /></Button>
            <button className="text-action" onClick={onClaim}>See how to claim <ArrowDown size={15} /></button>
          </motion.div>
          <motion.div className="hero-proof" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.48 }}>
            <div className="proof-avatars"><span>✦</span><span>◉</span><span>✳</span><span>+</span></div>
            <span>A gift in <strong>30 seconds</strong></span><span className="proof-separator">·</span><span>No hassle</span>
          </motion.div>
        </div>
        <FloatingVoucher voucher={voucher} />
      </section>

      <motion.section className="how-strip" initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.35 }} transition={{ duration: 0.55 }}>
        <div className="how-intro"><span className="section-kicker">IT’S THAT SIMPLE</span><h2>Three steps.<br /><span className="muted-heading">One wow moment.</span></h2></div>
        <div className="step-card"><span className="step-number">01</span><div className="step-icon step-icon-purple"><Sparkles size={18} /></div><h3>Create a gift card</h3><p>Choose a design, token, and amount, then add a few warm words.</p></div>
        <div className="step-card"><span className="step-number">02</span><div className="step-icon step-icon-green"><ArrowUpRight size={18} /></div><h3>Share the link</h3><p>Share it in a message. No wallet addresses or complicated steps.</p></div>
        <div className="step-card"><span className="step-number">03</span><div className="step-icon step-icon-blue"><Gift size={18} /></div><h3>Let them open it</h3><p>The recipient opens the envelope and claims the gift.</p></div>
      </motion.section>

      <motion.section className="home-bottom-cta" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }}>
        <div><span className="section-kicker">A SMALL GESTURE. A BIG FEELING.</span><h2>It’s the perfect time<br /><span className="gradient-text">to make someone’s day.</span></h2></div>
        <Button onClick={onCreate}>Create a gift card <ArrowRight className="button-arrow" size={17} /></Button>
        <div className="cta-glow" />
      </motion.section>
    </motion.main>
  )
}

function CreatePage({ voucher, setVoucher, onGenerated, onToast }) {
  const [isApiLoading, setIsApiLoading] = useState(false)
  const [secretWord, setSecretWord] = useState('')
  const [secretWordConfirm, setSecretWordConfirm] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoverySignature, setRecoverySignature] = useState('')
  const [pendingRegistration, setPendingRegistration] = useState(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem('solgift:pending-registration:v1') || 'null')
      if (!stored?.request?.voucherId || !stored?.request?.txHash || !stored?.voucher) return null
      const template = templates.find((item) => item.id === stored.voucher.template?.id) || templates[0]
      return { ...stored, voucher: { ...initialVoucher, ...stored.voucher, template }, secretWord: '' }
    } catch { return null }
  })

  useEffect(() => {
    try {
      if (!pendingRegistration) sessionStorage.removeItem('solgift:pending-registration:v1')
      else {
        const { secretWord: _secretWord, ...safePending } = pendingRegistration
        sessionStorage.setItem('solgift:pending-registration:v1', JSON.stringify(safePending))
      }
    } catch { /* Session storage may be unavailable; in-memory recovery still works. */ }
  }, [pendingRegistration])
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  function update(key, value) { setVoucher((current) => ({ ...current, [key]: value })) }

  async function registerConfirmedVoucher(pending) {
    let createdVoucher
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        createdVoucher = await voucherApi('/api/escrow/create', { ...pending.request, secretWord: pending.secretWord })
        break
      } catch (error) {
        const retryable = !error.status || error.status === 429 || error.status >= 500
        if (!retryable || attempt === 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 800 * (2 ** attempt)))
      }
    }
    const voucherId = createdVoucher?.voucherId || pending.request.voucherId
    if (!voucherId) throw new Error('The API did not return a voucher ID')
    const link = new URL(window.location.href)
    link.search = ''
    link.searchParams.set('id', voucherId)
    const next = { ...pending.voucher, link: link.toString(), voucherId, signature: pending.request.txHash, status: 'active' }
    setVoucher(next)
    setPendingRegistration(null)
    onGenerated(next, pending.secretWord)
    onToast({ type: 'success', message: 'Gift card created' })
  }

  async function retryRegistration() {
    if (!pendingRegistration || isApiLoading) return
    if ([...secretWord.trim()].length < 12) {
      onToast({ type: 'error', message: 'Enter the original secret phrase to safely recover registration' })
      return
    }
    setIsApiLoading(true)
    try {
      await registerConfirmedVoucher({ ...pendingRegistration, secretWord })
    } catch (error) {
      onToast({ type: 'error', message: `Payment confirmed, but registration failed: ${error.message}. Do not send the payment again. Signature: ${pendingRegistration.request.txHash}` })
    } finally { setIsApiLoading(false) }
  }

  async function recoverConfirmedTransfer() {
    if (!publicKey) {
      onToast({ type: 'error', message: 'Connect the wallet that sent the gift' })
      return
    }
    if (recoverySignature.trim().length < 64) {
      onToast({ type: 'error', message: 'Paste the confirmed transaction signature from Solscan' })
      return
    }
    if ([...secretWord.trim()].length < 12) {
      onToast({ type: 'error', message: 'Enter the original secret phrase for this gift' })
      return
    }
    setIsApiLoading(true)
    try {
      const result = await voucherApi('/api/escrow/recover', {
        senderAddress: publicKey.toBase58(), txHash: recoverySignature.trim(), secretWord,
      })
      const template = templates.find((item) => item.id === result.templateId) || templates[0]
      const link = new URL(window.location.href)
      link.search = ''
      link.searchParams.set('id', result.voucherId)
      const next = {
        ...voucher, ...result, template, amount: String(result.amount),
        link: link.toString(), signature: recoverySignature.trim(), status: 'active',
      }
      setVoucher(next)
      setPendingRegistration(null)
      onGenerated(next, secretWord)
      onToast({ type: 'success', message: 'Gift registered. You can now share the link.' })
    } catch (error) {
      onToast({ type: 'error', message: `Could not finish registering the confirmed transfer: ${error.message}. Do not send the money again. Signature: ${recoverySignature.trim()}` })
    } finally { setIsApiLoading(false) }
  }

  function generate() {
    if (isApiLoading) return
    void fundVoucher()
  }

  async function fundVoucher() {
    if (!publicKey) {
      onToast({ type: 'error', message: 'Connect a Solana wallet first' })
      return
    }
    if (!VOUCHER_API) {
      onToast({ type: 'error', message: 'Escrow API is not configured. No transfer was sent.' })
      return
    }
    if ((import.meta.env.VITE_SOLANA_NETWORK || 'devnet') !== 'devnet') {
      onToast({ type: 'error', message: 'The gift program currently works on Devnet only' })
      return
    }
    if ([...secretWord.trim()].length < 12 || secretWord !== secretWordConfirm) {
      onToast({ type: 'error', message: secretWord !== secretWordConfirm ? 'Secret phrases do not match' : 'Choose a secret phrase at least 12 characters long' })
      return
    }
    setIsApiLoading(true)
    let signature
    try {
      onToast({ type: 'sent', message: 'Preparing your gift…' })
      const preparation = await voucherApi('/api/escrow/prepare', {
        senderAddress: publicKey.toBase58(), currency: voucher.currency,
        amount: Number(voucher.amount), templateId: voucher.template.id, message: voucher.message,
        secretWord, onchain: true,
      })
      if (!preparation.escrowAddress || !preparation.giftHash || !preparation.voucherId) {
        throw new Error('The API did not prepare the on-chain gift. No funds were sent.')
      }
      if (preparation.programAbiVersion && preparation.programAbiVersion !== SOLGIFT_PROGRAM_ABI) {
        throw new Error('The site and escrow API use different program versions. Refresh the page and try again. No funds were sent.')
      }
      const transaction = new Transaction()
      const decimals = voucher.currency === 'SOL' ? 9 : 6
      const amount = BigInt(Math.round(Number(voucher.amount) * 10 ** decimals))
      if (amount <= 0n) throw new Error('Enter a valid gift amount')
      transaction.add(await createGiftInstruction({
        creator: publicKey, giftAddress: preparation.escrowAddress,
        giftHash: decodeBase64Url(preparation.giftHash), currency: voucher.currency,
        amount, feeReserveLamports: BigInt(preparation.feeReserveLamports || '0'), expiresAt: preparation.expiresAt,
        programAbiVersion: preparation.programAbiVersion || SOLGIFT_PROGRAM_ABI,
      }))
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      transaction.feePayer = publicKey
      transaction.recentBlockhash = blockhash
      const simulation = await connection.simulateTransaction(transaction)
      if (simulation.value.err) {
        console.error('Voucher funding simulation failed', simulation.value.err, simulation.value.logs)
        const details = simulation.value.logs?.slice(-3).join(' ')
        throw new Error(`Transaction preflight failed. No funds were sent.${details ? ` ${details}` : ''}`)
      }
      signature = await sendTransaction(transaction, connection, { preflightCommitment: 'confirmed' })
      onToast({ type: 'sent', message: 'Transaction sent' })
      await confirmSubmittedTransaction(connection, { signature, blockhash, lastValidBlockHeight })
      onToast({ type: 'sent', message: 'Registering your gift…' })
      const pending = {
        request: {
          voucherId: preparation.voucherId, senderAddress: publicKey.toBase58(), amount: Number(voucher.amount),
          currency: voucher.currency, templateId: voucher.template.id, message: voucher.message, txHash: signature,
        },
        voucher: { ...voucher }, secretWord,
      }
      setPendingRegistration(pending)
      try {
        await registerConfirmedVoucher(pending)
      } catch (error) {
        console.error('Confirmed voucher registration failed', error)
        throw new Error(`Transfer confirmed, but gift registration failed: ${error.message}. Do not send the payment again. You can retry registration below. Signature: ${signature}`)
      }
    } catch (error) {
      console.error('Voucher funding failed', error)
      const rejected = /reject|declin|cancel/i.test(`${error?.name} ${error?.message}`)
      const message = rejected ? 'Transaction was rejected' : `Could not finish creating the gift: ${error?.message || 'network error'}${signature ? ` Signature: ${signature}` : ''}`
      onToast({ type: 'error', message })
    } finally {
      setIsApiLoading(false)
    }
  }

  return (
    <motion.main className="page create-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <div className="page-heading">
        <span className="section-kicker"><span className="live-dot" /> GIFT STUDIO</span>
        <h1>Make it a moment.</h1>
        <p>Every gift starts with one simple choice.</p>
      </div>
      <div className="creator-layout">
        <section className="creator-form glass-panel">
          <div className="form-section">
            <div className="form-heading"><span className="form-step">01</span><div><h2>Choose a feeling</h2><p>What are you celebrating?</p></div></div>
            <div className="template-grid">
              {templates.map((template, index) => (
                <motion.button key={template.id} onClick={() => update('template', template)} className={`template-card template-${template.style} ${voucher.template.id === template.id ? 'template-selected' : ''}`} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }}>
                  <span className="template-art"><span className="template-orb">{template.emoji}</span><span className="template-tag">{template.tag}</span></span>
                  <span className="template-name">{template.title}</span>
                  <span className="template-check">{voucher.template.id === template.id && <Check size={12} />}</span>
                  {index === 0 && <span className="popular-badge">POPULAR</span>}
                </motion.button>
              ))}
            </div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">02</span><div><h2>Add value</h2><p>Choose a token and gift amount.</p></div></div>
            <div className="field-label-row"><label>Gift currency</label><span className="field-note"><ShieldCheck size={13} /> Network fees are paid separately</span></div>
            <div className="currency-switch" role="group" aria-label="Gift currency">
              {['SOL', 'USDC'].map((coin) => (
                <button key={coin} className={`currency-option ${voucher.currency === coin ? 'currency-selected' : ''}`} onClick={() => update('currency', coin)}>
                  {coin === 'SOL' ? <SolMark small /> : <span className="usdc-mark">$</span>}
                  <span>{coin}</span><small>{coin === 'SOL' ? 'Solana' : 'USD Coin'}</small>
                  {voucher.currency === coin && <span className="currency-check"><Check size={11} /></span>}
                </button>
              ))}
            </div>
            <label className="input-label" htmlFor="gift-amount">Amount</label>
            <div className="amount-input-wrap"><input id="gift-amount" type="number" min="0.01" step={voucher.currency === 'SOL' ? '0.01' : '1'} value={voucher.amount} onChange={(event) => update('amount', event.target.value)} placeholder="0.25"/><span className="amount-unit">{voucher.currency}</span><ChevronDown size={15} /></div>
            <div className="amount-hint"><span>Minimum amount</span><span>{voucher.currency === 'SOL' ? '0.01 SOL' : '1 USDC'}</span></div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">03</span><div><h2>Add a personal note</h2><p>A warm message makes the gift personal.</p></div></div>
            <label className="input-label" htmlFor="gift-message">Message for the recipient <span>OPTIONAL</span></label>
            <textarea id="gift-message" maxLength={120} value={voucher.message} onChange={(event) => update('message', event.target.value)} placeholder="Write something kind…" />
            <div className="amount-hint message-hint"><span>Keep it kind, please</span><span>{voucher.message.length}/120</span></div>
          </div>

          <div className="form-separator" />

          <div className="form-section">
            <div className="form-heading"><span className="form-step">04</span><div><h2>Protect your gift</h2><p>The recipient will need the link and your secret phrase.</p></div></div>
            <label className="input-label" htmlFor="gift-secret-word">Secret phrase</label>
            <div className="amount-input-wrap secret-word-input-wrap"><input id="gift-secret-word" type="password" autoComplete="off" maxLength={256} value={secretWord} onChange={(event) => setSecretWord(event.target.value)} placeholder="For example, three words" /></div>
            <label className="input-label secret-word-confirm-label" htmlFor="gift-secret-word-confirm">Confirm your phrase</label>
            <div className="amount-input-wrap secret-word-input-wrap"><input id="gift-secret-word-confirm" type="password" autoComplete="new-password" maxLength={256} value={secretWordConfirm} onChange={(event) => setSecretWordConfirm(event.target.value)} placeholder="Enter your secret phrase again" /></div>
            <div className="amount-hint"><span>At least 12 characters; a few words are best</span></div>
            <p className="secret-word-note">Keep the phrase out of the link. Send it to the recipient separately.</p>
          </div>

          <div className="form-footer">
            <p className="devnet-note">This site runs on Solana Devnet. In Solflare or Phantom, enable Testnet and select Solana Devnet, or your wallet may not be able to verify transactions.</p>
            <div className="secure-note"><LockKeyhole size={14} /><span>Your private key stays with you</span></div>
            <Button onClick={generate} className="generate-button" disabled={isApiLoading || !Number(voucher.amount) || Number(voucher.amount) <= 0 || [...secretWord.trim()].length < 12 || secretWord !== secretWordConfirm}>
              {isApiLoading ? <><span className="spinner" /> Creating your gift card…</> : <>Create gift link <ArrowRight size={16} className="button-arrow" /></>}
            </Button>
          </div>
          {pendingRegistration && <div className="registration-recovery" role="status">
            <p>Payment confirmed, but registration is incomplete. Do not send the money again. Enter the same secret phrase you used during payment and retry registration.</p>
            <button type="button" onClick={retryRegistration} disabled={isApiLoading || [...secretWord.trim()].length < 12}>{isApiLoading ? 'Retrying registration…' : 'Retry gift registration'}</button>
          </div>}
          <div className="manual-recovery">
            <button type="button" className="manual-recovery-toggle" aria-expanded={recoveryOpen} onClick={() => setRecoveryOpen((value) => !value)}>
              Sent the transfer but did not get a link?
            </button>
            {recoveryOpen && <div className="manual-recovery-panel">
              <p>Do not send the money again. Connect the same wallet, enter the original secret phrase, and paste the transaction signature from Solscan.</p>
              <label className="input-label" htmlFor="recovery-signature">Transaction signature</label>
              <input id="recovery-signature" className="recovery-signature-input" value={recoverySignature} onChange={(event) => setRecoverySignature(event.target.value.trim())} placeholder="Signature from Solscan" autoComplete="off" />
              <button type="button" onClick={recoverConfirmedTransfer} disabled={isApiLoading || recoverySignature.trim().length < 64 || [...secretWord.trim()].length < 12}>
                {isApiLoading ? 'Checking transfer…' : 'Finish gift registration'}
              </button>
            </div>}
          </div>
        </section>

        <aside className="preview-column">
          <div className="preview-sticky">
            <div className="preview-caption"><span className="section-kicker">LIVE PREVIEW</span><span><span className="live-dot" /> UPDATING</span></div>
            <div className={`preview-card card-${voucher.template.style}`}>
              <div className="preview-card-top"><span>GIFT CARD</span><Sparkles size={14} /></div>
              <div className="preview-center"><div className="preview-circle"><span>{voucher.template.emoji}</span><i>✦</i><b>✳</b></div></div>
              <div className="preview-card-bottom"><div><span className="voucher-eyebrow">{voucher.template.tag}</span><h3>{voucher.template.title}</h3></div><div className="preview-amount"><span>{voucher.amount || '0.00'}</span><small>{voucher.currency}</small></div></div>
            </div>
            <motion.div className="preview-summary" layout>
              <span><span className="summary-token">{voucher.currency === 'SOL' ? <SolMark small /> : <span className="usdc-mark mini">$</span>}</span>Gift for the recipient</span>
              <strong>{formatAmount(voucher.amount, voucher.currency)}</strong>
            </motion.div>
            <div className="preview-note"><div className="note-icon"><Zap size={14} /></div><p><strong>The reveal is yours.</strong><br />The recipient will see what’s inside only after opening the link.</p></div>
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
  const hasGift = Boolean(voucher.voucherId)
  const isExpired = voucher.status === 'expired' || (voucher.expiresAt && Date.now() >= voucher.expiresAt * 1000)
  const isUnavailable = claimed || voucher.status === 'claimed' || voucher.status === 'refunded' || isExpired

  function openGift() {
    if (!opened) setOpened(true)
  }

  async function claimGift() {
    if (!publicKey) {
      onToast({ type: 'error', message: 'Connect the recipient’s wallet to claim this gift' })
      return
    }
    if (!voucher.voucherId || !VOUCHER_API) {
      onToast({ type: 'error', message: 'This link is not connected to the escrow service. No request was sent.' })
      return
    }
    if ([...secretWord.trim()].length < 12) {
      onToast({ type: 'error', message: 'Enter the secret phrase from the sender' })
      return
    }
    if (isApiLoading || isUnavailable) return
    setIsApiLoading(true)
    try {
      if (voucher.onchain && voucher.giftAddress) {
        const giftAccount = await connection.getAccountInfo(new PublicKey(voucher.giftAddress), 'confirmed')
        if (!giftAccount?.owner.equals(SOLGIFT_PROGRAM_ID) || giftAccount.data.length < 163) {
          throw new Error('Could not read the gift status from Solana')
        }
        const status = giftAccount.data[129]
        if (status === 1) {
          setClaimed(true)
          const recipient = giftAccount.data[130] === 1
            ? new PublicKey(giftAccount.data.subarray(131, 163)).toBase58()
            : ''
          throw new Error(`This gift has already been claimed${recipient ? ` by wallet ${recipient.slice(0, 5)}…${recipient.slice(-5)}` : ''}`)
        }
        if (status === 2) throw new Error('This gift expired and the sender has reclaimed the funds')
        if (status !== 0) throw new Error('This gift is currently unavailable on Solana')
      }
      onToast({ type: 'sent', message: 'Requesting payout…' })
      const result = await voucherApi('/api/escrow/claim', {
        voucherId: voucher.voucherId, recipientAddress: publicKey.toBase58(), secretWord,
      })
      let txHash
      let confirmation
      if (result.onchain) {
        if (!result.sponsoredTransaction || !result.blockhash || !result.lastValidBlockHeight) {
          throw new Error('The API did not return a sponsored claim transaction.')
        }
        const transaction = Transaction.from(Buffer.from(result.sponsoredTransaction, 'base64'))
        onToast({ type: 'sent', message: 'Approve the sponsored claim in your wallet' })
        txHash = await sendTransaction(transaction, connection, { preflightCommitment: 'confirmed' })
        onToast({ type: 'sent', message: 'Transaction sent. Waiting for confirmation…' })
        confirmation = await confirmSubmittedTransaction(connection, {
          signature: txHash, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight,
        })
      } else {
        txHash = result.txHash || result.signature
        if (!txHash) throw new Error('The escrow API did not return a payout transaction hash')
        onToast({ type: 'sent', message: 'Payout sent. Waiting for confirmation…' })
        confirmation = result.blockhash && result.lastValidBlockHeight
          ? await confirmSubmittedTransaction(connection, { signature: txHash, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight })
          : await confirmSubmittedTransaction(connection, txHash)
      }
      if (confirmation.value.err) throw new Error('Network error while confirming payout')
      setClaimed(true)
      onToast({ type: 'success', message: 'Gift claimed successfully' })
    } catch (error) {
      console.error('Voucher claim failed', error)
      const rejected = /reject|declin|cancel/i.test(`${error?.name} ${error?.message}`)
      const message = /secret word is incorrect/i.test(error?.message || '') ? 'Incorrect secret phrase'
        : /too many secret-word attempts/i.test(error?.message || '') ? 'Too many attempts. Try again in 15 minutes'
          : /predates secret-word/i.test(error?.message || '') ? 'This gift was created before phrase protection was added. Ask the sender to create a new one'
            : /already been claimed|expired|no longer claimable/i.test(error?.message || '') ? error.message
            : `Claim failed: ${error?.message || 'Service unavailable'}`
      onToast({ type: 'error', message: rejected ? 'Transaction was rejected' : message })
    } finally { setIsApiLoading(false) }
  }

  return (
    <motion.main className="page claim-page" variants={slideVariants} initial="initial" animate="animate" exit="exit">
      <div className="claim-topline"><span className="section-kicker">{hasGift ? 'A LITTLE SOMETHING FOR YOU' : 'GIFTS FOR YOU'}</span><span className="demo-tag"><span className="live-dot" /> {isVoucherLoading && !hasGift ? 'CHECKING LINK' : hasGift ? 'SOLANA VOUCHER' : 'NOTHING HERE YET'}</span></div>
      <section className={`claim-scene ${opened ? 'claim-opened' : ''}`}>
        <div className="claim-halo" />
        <AnimatePresence>{claimed && <Confetti key="confetti" />}</AnimatePresence>
        {isVoucherLoading && !hasGift ? (
          <div className="claim-empty-state" role="status"><span className="spinner" /><p>Checking your gift link…</p></div>
        ) : !hasGift ? (
          <div className="claim-empty-state">
            <div className="claim-empty-icon"><Gift size={27} /></div>
            <span className="section-kicker">INCOMING GIFTS</span>
            <h1>No gifts yet</h1>
            <p>When someone sends you a gift, open their link to see it here.</p>
            <span className="claim-empty-note"><LockKeyhole size={12} /> The sender will share the secret phrase separately</span>
          </div>
        ) : !opened ? (
          <motion.div className="envelope-wrap" initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.55, type: 'spring', bounce: 0.24 }}>
            <motion.div className="envelope-orbit" animate={{ rotate: 360 }} transition={{ duration: 34, repeat: Infinity, ease: 'linear' }} />
            <motion.button className="gift-envelope" onClick={openGift} aria-label="Open gift" whileHover={{ scale: 1.045, rotate: -1.5 }} whileTap={{ scale: 0.96 }} animate={{ y: [0, -9, 0] }} transition={{ y: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' } }}>
              <div className="envelope-card-back"><span>FOR YOU</span><i>✦</i></div>
              <div className="envelope-body"><div className="envelope-flap" /><div className="envelope-seal"><Gift size={27} /><span>✳</span></div><div className="envelope-fold-left"/><div className="envelope-fold-right"/></div>
              <span className="envelope-glint" />
            </motion.button>
            <motion.div className="envelope-label" animate={{ opacity: [0.6, 1, 0.6] }} transition={{ duration: 2.2, repeat: Infinity }}>{voucher.status === 'claimed' ? 'GIFT CLAIMED' : voucher.status === 'refunded' || isExpired ? 'GIFT EXPIRED' : 'A GIFT FOR YOU'}</motion.div>
          </motion.div>
        ) : (
          <motion.div className="revealed-card" initial={{ opacity: 0, scale: 0.72, y: 28, rotateX: -14 }} animate={{ opacity: 1, scale: 1, y: 0, rotateX: 0 }} transition={{ duration: 0.72, type: 'spring', bounce: 0.2 }}>
            <div className={`revealed-art card-${voucher.template.style}`}><span className="revealed-emoji">{voucher.template.emoji}</span><span className="revealed-art-spark">✦</span><span className="revealed-art-dot">✳</span></div>
            <span className="voucher-eyebrow">YOUR GIFT</span>
            <motion.div className="revealed-amount" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.18, type: 'spring' }}>
              <strong>{formatAmount(voucher.amount, voucher.currency).split(' ')[0]}</strong>
              <span>{voucher.currency === 'SOL' ? <SolMark small /> : <span className="usdc-mark mini">$</span>}{voucher.currency}</span>
            </motion.div>
            <h1>{voucher.template.title}</h1>
            <p className="revealed-message">“{voucher.message || 'A little surprise just for you ✨'}”</p>
            <div className="revealed-from"><span className="from-avatar">✳</span><span>With love, <strong>your friend</strong></span><span className="from-dot">·</span><span className="onchain-label"><SolMark small /> on-chain</span></div>
            {!isUnavailable && <div className="claim-secret-field"><label className="input-label" htmlFor="claim-secret-word">Secret phrase</label><div className="amount-input-wrap secret-word-input-wrap"><input id="claim-secret-word" type="password" autoComplete="off" maxLength={256} value={secretWord} onChange={(event) => setSecretWord(event.target.value)} placeholder="Enter the phrase from the sender" /></div></div>}
            <Button onClick={claimGift} className={`claim-button ${claimed || voucher.status === 'claimed' ? 'claim-button-done' : ''}`} disabled={isVoucherLoading || isApiLoading || isUnavailable || [...secretWord.trim()].length < 12}>
              {claimed || voucher.status === 'claimed' ? <><Check size={17} /> Gift claimed</> : isExpired || voucher.status === 'refunded' ? <>Claim period ended</> : isApiLoading ? <><span className="spinner" /> Sending…</> : <>Claim to wallet <ArrowRight className="button-arrow" size={17} /></>}
            </Button>
            <span className="claim-footnote"><LockKeyhole size={12} /> {publicKey ? 'Smart contract transfer after wallet approval' : 'Connect the recipient’s wallet first'}</span>
          </motion.div>
        )}
      </section>
      {hasGift && !isVoucherLoading && !opened && <div className="claim-instructions"><span>01</span><p>Tap the envelope<br />to reveal your surprise</p></div>}
      <div className="claim-bottom-note"><span>{hasGift ? 'SECURED BY SOLANA' : 'SOLANA GIFT VOUCHERS'}</span><span>{hasGift ? 'No hidden catches. Just a gift.' : 'Gifts shared with you will appear here.'}</span><span>✳</span></div>
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
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        <div className="modal-success"><div className="modal-success-ring"><Check size={23} /></div><span className="success-ray ray-a"/><span className="success-ray ray-b"/></div>
        <span className="section-kicker">WHAT A SURPRISE!</span>
        <h2 id="link-modal-title">Your gift<br /><span className="gradient-text">is ready.</span></h2>
        <p className="modal-description">Share the link with your friend and send the secret phrase separately.</p>
        <div className="link-copy-field"><span>{voucher.link}</span><button onClick={copyLink} aria-label="Copy link">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
        <Button onClick={copyLink} className="modal-copy-button">{copied ? <><Check size={16} /> Copied</> : <>Copy link <ArrowRight size={16} className="button-arrow" /></>}</Button>
        <div className="secret-share-card"><div><span className="section-kicker">SEND SEPARATELY FROM THE LINK</span><strong>{voucher.secretWord}</strong></div><button onClick={copySecretWord} aria-label="Copy secret phrase">{copiedSecret ? <Check size={15} /> : <Copy size={15} />}</button></div>
        <p className="secret-share-note">Anyone with both the link and the phrase can claim the gift.</p>
        <button className="see-claim-link" onClick={onClaim}>Open recipient view <ArrowUpRight size={14} /></button>
        <div className="modal-bottom"><LockKeyhole size={12} /> SOLANA GIFT · THE LINK DOES NOT CONTAIN THE SECRET PHRASE</div>
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
      setToast({ type: 'error', message: 'API error: invalid gift ID' })
      return
    }
    if (!initialVoucherId) return
    if (!VOUCHER_API) {
      setToast({ type: 'error', message: 'API error: gift service is not configured' })
      return
    }
    let active = true
    setIsApiLoading(true)
    setToast({ type: 'sent', message: 'Checking gift…' })
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
      .catch((error) => { if (active) setToast({ type: 'error', message: `API error: ${error.message || 'Gift not found'}` }) })
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
      <footer className="site-footer"><button className="footer-brand" onClick={() => navigate('home')}><span className="brand-icon small-brand-icon"><Gift size={13} /></span> solgift<span className="brand-dot">.</span></button><span>Small gestures. Big energy.</span><span className="footer-right">MADE WITH <span>✳</span> ON SOLANA</span></footer>
      <AnimatePresence>{toast && <StatusToast key={`${toast.type}-${toast.message}`} toast={toast} />}</AnimatePresence>
      <AnimatePresence>{modalOpen && <LinkModal voucher={{ ...voucher, secretWord: deliverySecretWord }} onClose={() => { setModalOpen(false); setDeliverySecretWord('') }} onClaim={() => navigate('claim')} />}</AnimatePresence>
    </div>
  )
}

export default App
