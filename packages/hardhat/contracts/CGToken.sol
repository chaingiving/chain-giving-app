// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { ERC1155Burnable } from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title CGToken — ERC-1155 multi-token for a Chain.Giving program
/// @notice One deployment per program. Supports multiple token types in a single contract.
///         Each type is configured independently: unlimited supply (fungible), capped supply
///         (semi-fungible badges), or supply of 1 (unique NFT). Owner (typically CGProgram)
///         controls type definition and minting. Each type can independently enable/disable
///         user transfers and burns.
contract CGToken is ERC1155Burnable, Ownable, EIP712 {
    struct TokenType {
        string name;
        string symbol;
        uint256 maxSupply; // 0 = unlimited; 1 = unique NFT; N = capped semi-fungible
        uint256 totalMinted;
        bool transferable; // true = holders can transfer; false = soulbound (owner can always transfer)
        bool burnable; // true = holders can burn; false = burn disabled (owner can always burn)
    }

    mapping(uint256 => TokenType) public tokenTypes;
    mapping(uint256 => string) private _uris;
    mapping(address => bool) public authorizedTransferrers;
    /// @notice Per-owner nonce for signed setApprovalForAll. Each successful call
    ///         increments the value, invalidating older signatures.
    mapping(address => uint256) public nonces;
    uint256 public nextTokenId;

    /// @dev EIP-712 typehash for the signed-approval payload. Mirrors the function
    ///      arguments minus the signature itself.
    bytes32 private constant APPROVAL_FOR_ALL_TYPEHASH =
        keccak256("ApprovalForAll(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)");

    event TokenTypeDefined(
        uint256 indexed tokenId,
        string name,
        string symbol,
        uint256 maxSupply,
        bool transferable,
        bool burnable
    );
    event AuthorizedTransferrerSet(address indexed account, bool authorized);

    error UnknownTokenType(uint256 tokenId);
    error ExceedsMaxSupply(uint256 tokenId, uint256 requested, uint256 remaining);
    error TransferDisabled(uint256 tokenId);
    error BurnDisabled(uint256 tokenId);
    error ExpiredSignature(uint256 deadline);
    error InvalidApprovalSignature();

    constructor(address owner_) ERC1155("") Ownable(owner_) EIP712("CGToken", "1") {}

    /// @notice Set operator approval on behalf of `owner_` using an off-chain
    ///         signed authorization. Lets a relayer (typically a paymaster-sponsored
    ///         smart account) grant itself approval without the owner needing to
    ///         send a transaction first. ECDSA + ERC-1271 signatures both supported.
    /// @dev    The signed payload is an EIP-712 `ApprovalForAll` struct.
    ///         Nonces are per-owner sequential to prevent replay.
    function setApprovalForAllWithSignature(
        address owner_,
        address operator,
        bool approved,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert ExpiredSignature(deadline);

        uint256 nonce = nonces[owner_]++;
        bytes32 structHash = keccak256(
            abi.encode(APPROVAL_FOR_ALL_TYPEHASH, owner_, operator, approved, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        if (!SignatureChecker.isValidSignatureNow(owner_, digest, signature)) {
            revert InvalidApprovalSignature();
        }

        _setApprovalForAll(owner_, operator, approved);
    }

    /// @notice Grant or revoke an address's ability to bypass soulbound restrictions.
    ///         Used to allow CGDistribution contracts to transfer non-transferable tokens.
    function setAuthorizedTransferrer(address account, bool authorized) external onlyOwner {
        authorizedTransferrers[account] = authorized;
        emit AuthorizedTransferrerSet(account, authorized);
    }

    /// @notice Define a new token type. Returns the auto-assigned tokenId (starts at 0).
    /// @param name_         Display name (e.g. "Food Voucher")
    /// @param symbol_       Short symbol (e.g. "FOOD")
    /// @param maxSupply_    Hard cap on total minted. 0 = unlimited (fungible), 1 = unique NFT,
    ///                      N = capped supply (badges, tickets, etc.)
    /// @param uri_          Optional per-type metadata URI; falls back to contract-level URI if empty
    /// @param transferable_ Whether holders can transfer tokens (owner/program can always transfer)
    /// @param burnable_     Whether holders can burn tokens (owner/program can always burn)
    function defineTokenType(
        string calldata name_,
        string calldata symbol_,
        uint256 maxSupply_,
        string calldata uri_,
        bool transferable_,
        bool burnable_
    ) external onlyOwner returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        tokenTypes[tokenId] = TokenType({
            name: name_,
            symbol: symbol_,
            maxSupply: maxSupply_,
            totalMinted: 0,
            transferable: transferable_,
            burnable: burnable_
        });
        if (bytes(uri_).length > 0) {
            _uris[tokenId] = uri_;
        }
        emit TokenTypeDefined(tokenId, name_, symbol_, maxSupply_, transferable_, burnable_);
    }

    /// @notice Mint tokens of a given type to a recipient. onlyOwner.
    function mint(address to, uint256 tokenId, uint256 amount) external onlyOwner {
        _validateMint(tokenId, amount);
        tokenTypes[tokenId].totalMinted += amount;
        _mint(to, tokenId, amount, "");
    }

    /// @notice Batch mint multiple token types in one call. onlyOwner.
    function mintBatch(address to, uint256[] calldata tokenIds, uint256[] calldata amounts) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _validateMint(tokenIds[i], amounts[i]);
            tokenTypes[tokenIds[i]].totalMinted += amounts[i];
        }
        _mintBatch(to, tokenIds, amounts, "");
    }

    /// @notice Per-type metadata URI; falls back to contract-level URI if none set.
    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory tokenUri = _uris[tokenId];
        if (bytes(tokenUri).length > 0) return tokenUri;
        return super.uri(tokenId);
    }

    /// @notice Return full metadata for a token type.
    function getTokenType(uint256 tokenId) external view returns (TokenType memory) {
        if (tokenId >= nextTokenId) revert UnknownTokenType(tokenId);
        return tokenTypes[tokenId];
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _validateMint(uint256 tokenId, uint256 amount) internal view {
        if (tokenId >= nextTokenId) revert UnknownTokenType(tokenId);
        TokenType storage tt = tokenTypes[tokenId];
        if (tt.maxSupply > 0 && tt.totalMinted + amount > tt.maxSupply)
            revert ExceedsMaxSupply(tokenId, amount, tt.maxSupply - tt.totalMinted);
    }

    /// @dev Enforce per-type transfer and burn restrictions.
    ///      Mints (from == 0) are always allowed (gated by onlyOwner on mint()).
    ///      The contract owner (CGProgram) and authorized transferrers (e.g. CGDistribution)
    ///      are always allowed to transfer and burn regardless of the flags.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        bool isMint = from == address(0);
        bool isPrivileged = _msgSender() == owner() || authorizedTransferrers[_msgSender()];

        if (!isMint && !isPrivileged) {
            bool isBurn = to == address(0);
            for (uint256 i = 0; i < ids.length; i++) {
                if (ids[i] >= nextTokenId) revert UnknownTokenType(ids[i]);
                TokenType storage tt = tokenTypes[ids[i]];
                if (isBurn) {
                    if (!tt.burnable) revert BurnDisabled(ids[i]);
                } else {
                    if (!tt.transferable) revert TransferDisabled(ids[i]);
                }
            }
        }

        super._update(from, to, ids, values);
    }
}
