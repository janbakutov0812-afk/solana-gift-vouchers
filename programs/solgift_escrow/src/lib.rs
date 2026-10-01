use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_sha256_hasher::hash;

declare_id!("A5cFtpUVnBncPqaBpUjHUtb9brk3qoPZSUjRdD3DTht2");

const USDC_DEVNET: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_MAINNET: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2q2xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS: u8 = 6;
const MAX_LIFETIME_SECONDS: i64 = 365 * 24 * 60 * 60;

#[program]
pub mod solgift_escrow {
    use super::*;

    /// Creates a gift PDA and transfers the gift amount into it.
    pub fn create_sol_gift(
        ctx: Context<CreateSolGift>,
        gift_hash: [u8; 32],
        amount_lamports: u64,
        expires_at: i64,
    ) -> Result<()> {
        validate_new_gift(&gift_hash, amount_lamports, expires_at)?;
        initialize_gift(
            &mut ctx.accounts.gift,
            ctx.accounts.creator.key(),
            gift_hash,
            Asset::Sol,
            Pubkey::default(),
            amount_lamports,
            expires_at,
            ctx.bumps.gift,
        )?;

        system_program::transfer(
            CpiContext::new(
                System::id(),
                Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.gift.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        emit!(GiftCreated {
            gift: ctx.accounts.gift.key(),
            creator: ctx.accounts.creator.key(),
            gift_hash,
            asset: Asset::Sol,
            mint: Pubkey::default(),
            amount: amount_lamports,
            expires_at,
        });
        Ok(())
    }

    /// Creates a USDC gift. Only the canonical devnet and mainnet USDC mints are accepted.
    pub fn create_usdc_gift(
        ctx: Context<CreateUsdcGift>,
        gift_hash: [u8; 32],
        amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        validate_new_gift(&gift_hash, amount, expires_at)?;
        validate_usdc_mint(&ctx.accounts.mint)?;
        initialize_gift(
            &mut ctx.accounts.gift,
            ctx.accounts.creator.key(),
            gift_hash,
            Asset::Usdc,
            ctx.accounts.mint.key(),
            amount,
            expires_at,
            ctx.bumps.gift,
        )?;

        token::transfer_checked(
            CpiContext::new(
                Token::id(),
                TransferChecked {
                    from: ctx.accounts.creator_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            amount,
            USDC_DECIMALS,
        )?;

        emit!(GiftCreated {
            gift: ctx.accounts.gift.key(),
            creator: ctx.accounts.creator.key(),
            gift_hash,
            asset: Asset::Usdc,
            mint: ctx.accounts.mint.key(),
            amount,
            expires_at,
        });
        Ok(())
    }

    /// Lets the first wallet holding the bearer link claim the gift before expiry.
    pub fn claim_sol_gift(
        ctx: Context<ClaimSolGift>,
        gift_hash: [u8; 32],
        gift_secret: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        validate_secret(gift, &gift_hash, &gift_secret)?;
        validate_claim(gift, Asset::Sol, now)?;
        let amount = transfer_lamports_from_gift(
            gift,
            &ctx.accounts.recipient.to_account_info(),
            gift.amount,
        )?;
        gift.recipient = Some(ctx.accounts.recipient.key());
        gift.status = GiftStatus::Claimed;
        emit!(GiftClaimed {
            gift: gift.key(),
            recipient: ctx.accounts.recipient.key(),
            asset: Asset::Sol,
            mint: Pubkey::default(),
            amount,
        });
        Ok(())
    }

    /// Lets the first wallet holding the bearer link claim the USDC gift before expiry.
    pub fn claim_usdc_gift(
        ctx: Context<ClaimUsdcGift>,
        gift_hash: [u8; 32],
        gift_secret: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        validate_secret(gift, &gift_hash, &gift_secret)?;
        validate_claim(gift, Asset::Usdc, now)?;
        validate_usdc_mint(&ctx.accounts.mint)?;
        require!(
            ctx.accounts.vault.amount >= gift.amount,
            EscrowError::InsufficientEscrow
        );
        let amount = ctx.accounts.vault.amount;
        let bump_seed = [gift.bump];
        let gift_seeds: &[&[u8]] = &[
            b"gift",
            ctx.accounts.creator.key.as_ref(),
            &gift_hash,
            &bump_seed,
        ];
        let signer_seeds = &[gift_seeds];
        token::transfer_checked(
            CpiContext::new(
                Token::id(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: gift.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            amount,
            USDC_DECIMALS,
        )?;
        gift.recipient = Some(ctx.accounts.recipient.key());
        gift.status = GiftStatus::Claimed;
        emit!(GiftClaimed {
            gift: gift.key(),
            recipient: ctx.accounts.recipient.key(),
            asset: Asset::Usdc,
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// Returns a SOL gift to its creator only after its expiry timestamp.
    pub fn refund_expired_sol_gift(
        ctx: Context<RefundExpiredSolGift>,
        gift_hash: [u8; 32],
    ) -> Result<()> {
        let _ = gift_hash;
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        validate_refund(gift, Asset::Sol, now)?;
        let amount = transfer_lamports_from_gift(
            gift,
            &ctx.accounts.creator.to_account_info(),
            gift.amount,
        )?;
        gift.status = GiftStatus::Refunded;
        emit!(GiftRefunded {
            gift: gift.key(),
            creator: ctx.accounts.creator.key(),
            asset: Asset::Sol,
            mint: Pubkey::default(),
            amount,
        });
        Ok(())
    }

    /// Returns a USDC gift to its creator only after its expiry timestamp.
    pub fn refund_expired_usdc_gift(
        ctx: Context<RefundExpiredUsdcGift>,
        gift_hash: [u8; 32],
    ) -> Result<()> {
        let _ = gift_hash;
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        validate_refund(gift, Asset::Usdc, now)?;
        validate_usdc_mint(&ctx.accounts.mint)?;
        require!(
            ctx.accounts.vault.amount >= gift.amount,
            EscrowError::InsufficientEscrow
        );
        let amount = ctx.accounts.vault.amount;
        let bump_seed = [gift.bump];
        let gift_seeds: &[&[u8]] = &[
            b"gift",
            ctx.accounts.creator.key.as_ref(),
            &gift_hash,
            &bump_seed,
        ];
        let signer_seeds = &[gift_seeds];
        token::transfer_checked(
            CpiContext::new(
                Token::id(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.creator_token.to_account_info(),
                    authority: gift.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            amount,
            USDC_DECIMALS,
        )?;
        gift.status = GiftStatus::Refunded;
        emit!(GiftRefunded {
            gift: gift.key(),
            creator: ctx.accounts.creator.key(),
            asset: Asset::Usdc,
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32])]
pub struct CreateSolGift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Gift::SPACE,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump
    )]
    pub gift: Account<'info, Gift>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32])]
pub struct CreateUsdcGift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Gift::SPACE,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump
    )]
    pub gift: Account<'info, Gift>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = gift,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32], gift_secret: [u8; 32])]
pub struct ClaimSolGift<'info> {
    /// CHECK: Used only as a PDA seed and checked against gift.creator by has_one.
    pub creator: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump = gift.bump,
        has_one = creator
    )]
    pub gift: Account<'info, Gift>,
    #[account(mut)]
    pub recipient: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32], gift_secret: [u8; 32])]
pub struct ClaimUsdcGift<'info> {
    /// CHECK: Used only as a PDA seed and checked against gift.creator by has_one.
    pub creator: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump = gift.bump,
        has_one = creator
    )]
    pub gift: Account<'info, Gift>,
    #[account(mut)]
    pub recipient: Signer<'info>,
    #[account(address = gift.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = gift,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    // Safe init_if_needed use: the account is the canonical ATA derived from this signer and mint.
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32])]
pub struct RefundExpiredSolGift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump = gift.bump,
        has_one = creator
    )]
    pub gift: Account<'info, Gift>,
}

#[derive(Accounts)]
#[instruction(gift_hash: [u8; 32])]
pub struct RefundExpiredUsdcGift<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [b"gift", creator.key().as_ref(), gift_hash.as_ref()],
        bump = gift.bump,
        has_one = creator
    )]
    pub gift: Account<'info, Gift>,
    #[account(address = gift.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = gift,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    // Recreate the creator's canonical ATA if they closed it while the gift was active.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Gift {
    /// SHA-256 of the bearer secret. The secret itself is never stored on-chain.
    pub gift_hash: [u8; 32],
    pub creator: Pubkey,
    pub asset: Asset,
    /// Default pubkey for SOL gifts; canonical allowlisted mint for USDC gifts.
    pub mint: Pubkey,
    /// Lamports for SOL or base units (6 decimals) for USDC.
    pub amount: u64,
    pub expires_at: i64,
    pub created_at: i64,
    pub status: GiftStatus,
    pub recipient: Option<Pubkey>,
    pub bump: u8,
    pub reserved: [u8; 16],
}

impl Gift {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 1 + 1 + 32 + 1 + 16;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Asset {
    Sol,
    Usdc,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GiftStatus {
    Active,
    Claimed,
    Refunded,
}

#[event]
pub struct GiftCreated {
    pub gift: Pubkey,
    pub creator: Pubkey,
    pub gift_hash: [u8; 32],
    pub asset: Asset,
    pub mint: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct GiftClaimed {
    pub gift: Pubkey,
    pub recipient: Pubkey,
    pub asset: Asset,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct GiftRefunded {
    pub gift: Pubkey,
    pub creator: Pubkey,
    pub asset: Asset,
    pub mint: Pubkey,
    pub amount: u64,
}

fn initialize_gift(
    gift: &mut Account<Gift>,
    creator: Pubkey,
    gift_hash: [u8; 32],
    asset: Asset,
    mint: Pubkey,
    amount: u64,
    expires_at: i64,
    bump: u8,
) -> Result<()> {
    gift.gift_hash = gift_hash;
    gift.creator = creator;
    gift.asset = asset;
    gift.mint = mint;
    gift.amount = amount;
    gift.expires_at = expires_at;
    gift.created_at = Clock::get()?.unix_timestamp;
    gift.status = GiftStatus::Active;
    gift.recipient = None;
    gift.bump = bump;
    gift.reserved = [0; 16];
    Ok(())
}

fn validate_new_gift(gift_hash: &[u8; 32], amount: u64, expires_at: i64) -> Result<()> {
    require!(
        gift_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidGiftSecret
    );
    require!(amount > 0, EscrowError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp;
    let lifetime = expires_at
        .checked_sub(now)
        .ok_or(EscrowError::InvalidExpiry)?;
    require!(
        lifetime > 0 && lifetime <= MAX_LIFETIME_SECONDS,
        EscrowError::InvalidExpiry
    );
    Ok(())
}

fn validate_secret(gift: &Gift, gift_hash: &[u8; 32], gift_secret: &[u8; 32]) -> Result<()> {
    require!(gift.gift_hash == *gift_hash, EscrowError::InvalidGiftSecret);
    require!(
        hash(gift_secret).to_bytes() == *gift_hash,
        EscrowError::InvalidGiftSecret
    );
    Ok(())
}

fn validate_usdc_mint(mint: &Account<Mint>) -> Result<()> {
    require!(
        mint.key() == USDC_DEVNET || mint.key() == USDC_MAINNET,
        EscrowError::UnsupportedMint
    );
    require!(mint.decimals == USDC_DECIMALS, EscrowError::UnsupportedMint);
    Ok(())
}

fn validate_claim(gift: &Gift, expected_asset: Asset, now: i64) -> Result<()> {
    require!(gift.asset == expected_asset, EscrowError::WrongAsset);
    require!(
        gift.status == GiftStatus::Active,
        EscrowError::GiftNotActive
    );
    require!(now < gift.expires_at, EscrowError::GiftExpired);
    Ok(())
}

fn validate_refund(gift: &Gift, expected_asset: Asset, now: i64) -> Result<()> {
    require!(gift.asset == expected_asset, EscrowError::WrongAsset);
    require!(
        gift.status == GiftStatus::Active,
        EscrowError::GiftNotActive
    );
    require!(now >= gift.expires_at, EscrowError::NotExpired);
    Ok(())
}

fn transfer_lamports_from_gift(
    gift: &Account<Gift>,
    destination: &AccountInfo,
    minimum_amount: u64,
) -> Result<u64> {
    let gift_info = gift.to_account_info();
    let gift_balance = gift_info.lamports();
    let rent_floor = Rent::get()?.minimum_balance(gift_info.data_len());
    let spendable = gift_balance
        .checked_sub(rent_floor)
        .ok_or(EscrowError::InsufficientEscrow)?;
    require!(spendable >= minimum_amount, EscrowError::InsufficientEscrow);
    // Include unsolicited SOL in the final payout so it cannot be stranded in the PDA.
    let amount = spendable;
    let destination_balance = destination.lamports();
    let new_destination_balance = destination_balance
        .checked_add(amount)
        .ok_or(EscrowError::AmountOverflow)?;
    let new_gift_balance = gift_balance
        .checked_sub(amount)
        .ok_or(EscrowError::InsufficientEscrow)?;

    **gift_info.try_borrow_mut_lamports()? = new_gift_balance;
    **destination.try_borrow_mut_lamports()? = new_destination_balance;
    Ok(amount)
}

#[error_code]
pub enum EscrowError {
    #[msg("Gift ID must contain at least one non-zero byte")]
    InvalidGiftSecret,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Expiry must be in the future and at most 365 days away")]
    InvalidExpiry,
    #[msg("The supplied mint is not supported USDC")]
    UnsupportedMint,
    #[msg("Gift asset does not match this instruction")]
    WrongAsset,
    #[msg("Gift is no longer active")]
    GiftNotActive,
    #[msg("Gift has expired and cannot be claimed")]
    GiftExpired,
    #[msg("Gift has not expired yet")]
    NotExpired,
    #[msg("Escrow balance is lower than the recorded amount")]
    InsufficientEscrow,
    #[msg("Amount calculation overflowed")]
    AmountOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gift_with_hash(gift_hash: [u8; 32]) -> Gift {
        Gift {
            gift_hash,
            creator: Pubkey::new_unique(),
            asset: Asset::Sol,
            mint: Pubkey::default(),
            amount: 1,
            expires_at: 1,
            created_at: 0,
            status: GiftStatus::Active,
            recipient: None,
            bump: 1,
            reserved: [0; 16],
        }
    }

    #[test]
    fn accepts_secret_matching_the_stored_hash() {
        let secret = [7; 32];
        let gift_hash = hash(&secret).to_bytes();
        let gift = gift_with_hash(gift_hash);

        assert!(validate_secret(&gift, &gift_hash, &secret).is_ok());
    }

    #[test]
    fn rejects_wrong_secret_even_when_gift_hash_is_correct() {
        let secret = [7; 32];
        let wrong_secret = [8; 32];
        let gift_hash = hash(&secret).to_bytes();
        let gift = gift_with_hash(gift_hash);

        assert!(validate_secret(&gift, &gift_hash, &wrong_secret).is_err());
    }

    #[test]
    fn rejects_hash_that_does_not_match_the_gift_account() {
        let secret = [7; 32];
        let stored_hash = hash(&secret).to_bytes();
        let supplied_hash = hash(&[9; 32]).to_bytes();
        let gift = gift_with_hash(stored_hash);

        assert!(validate_secret(&gift, &supplied_hash, &secret).is_err());
    }
}
