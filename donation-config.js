// Public receiving addresses only. No keys, wallet connection or payment tracking.
export const BITCOIN_ADDRESS='bc1qh40tkxmcs520jymdmzss6l59tcwq04fc2uxxw5';
export const MONERO_ADDRESS='8AxomMWD5jHDCh8UXY8WqEdmJyCDUN9eJc2zG4qmdCkPFAGir7TrMnM3VZTncVMbc9YXJBoSdZTDc3vuFeHJjhGLVNRvrGj';
export const BITCOIN_URI=`bitcoin:${BITCOIN_ADDRESS}`;
export const MONERO_URI=`monero:${MONERO_ADDRESS}`;

export const DONATIONS=Object.freeze([
  Object.freeze({addressId:'bitcoinAddress',copyId:'copyBitcoin',walletId:'openBitcoinWallet',statusId:'copyStatus',
    address:BITCOIN_ADDRESS,uri:BITCOIN_URI,qr:'donations/bitcoin-qr.png',copiedMessage:'donateCopied'}),
  Object.freeze({addressId:'moneroAddress',copyId:'copyMonero',walletId:'openMoneroWallet',statusId:'moneroCopyStatus',
    address:MONERO_ADDRESS,uri:MONERO_URI,qr:'donations/monero-qr.png',copiedMessage:'donateMoneroCopied'})
]);
