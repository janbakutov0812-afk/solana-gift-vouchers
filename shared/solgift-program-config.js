// The Devnet program currently deployed at SOLGIFT_PROGRAM_ID predates the
// sender-funded fee-reserve arguments. Keep clients aligned until its upgrade
// authority updates the program; switch to "fee-reserve" only after verifying
// the deployed Devnet IDL.
export const SOLGIFT_PROGRAM_ABI = 'legacy'
