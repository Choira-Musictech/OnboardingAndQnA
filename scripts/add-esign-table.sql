-- ===================================================================
-- App_Accounts_ESign - one row per attempt to e-sign a member's application form.
--
-- The member signs the generated application PDF after the pre-payment review and before
-- payment. Indian members (AccountRegType I / C) sign with eMudhra/emSigner Aadhaar eSign, NRI
-- members (NI / NC) with DocuSign - Provider says which one, ProviderRefId holds that provider's
-- id for the signing (emSigner WorkflowId, DocuSign EnvelopeId).
--
-- The row is written BEFORE the member is sent to the provider, so a return from the provider can
-- always be matched to a known account - a return for an id that is not in this table is ignored.
-- Status: INITIATED (sent to sign), COMPLETED (provider confirmed, signed PDF saved), FAILED.
--
-- Apply with:
--   npx prisma db execute --file scripts/add-esign-table.sql --schema prisma/schema.prisma
-- (or sqlcmd ... -f 65001 -i scripts/add-esign-table.sql). Idempotent, safe to re-run.
-- The AppAccountsESign model in prisma/schema.prisma mirrors it; run `npx prisma generate` after.
-- ===================================================================

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'App_Accounts_ESign')
BEGIN
    CREATE TABLE dbo.App_Accounts_ESign (
        ESignId          BIGINT IDENTITY(1,1) NOT NULL,
        AccountId        BIGINT NOT NULL,
        Provider         NVARCHAR(20) NOT NULL,
        ProviderRefId    NVARCHAR(100) NULL,
        DocumentId       NVARCHAR(100) NULL,
        Status           NVARCHAR(20) NOT NULL,
        SigningUrl       NVARCHAR(2000) NULL,
        UnsignedPdfPath  NVARCHAR(500) NULL,
        SignedPdfPath    NVARCHAR(500) NULL,
        ResponseJson     NVARCHAR(MAX) NULL,
        CreateDate       DATETIME NOT NULL CONSTRAINT DF_App_Accounts_ESign_CreateDate DEFAULT (GETDATE()),
        ModifedDate      DATETIME NULL,
        CompletedDate    DATETIME NULL,
        CONSTRAINT PK_App_Accounts_ESign PRIMARY KEY CLUSTERED (ESignId)
    );
    CREATE INDEX IX_App_Accounts_ESign_AccountId ON dbo.App_Accounts_ESign(AccountId);
    CREATE UNIQUE INDEX UQ_App_Accounts_ESign_Provider_Ref ON dbo.App_Accounts_ESign(Provider, ProviderRefId) WHERE ProviderRefId IS NOT NULL;
    PRINT 'Created App_Accounts_ESign';
END
ELSE
    PRINT 'App_Accounts_ESign already exists, skipping';
