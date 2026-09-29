-- Mirrors IPRS's own dbo.GetStateBookId, read live off mraai_uat (OBJECT_DEFINITION), verbatim -
-- registration.service.js's resolveAndPersistBookId() calls this by name, so it must exist locally
-- with the exact same behavior as prod, including the Legal Heir/Self-Release/FC branches this app
-- never produces but the function still needs to match prod's real logic.
--
-- Run: sqlcmd -S tcp:localhost,1433 -U iprs_app -P iprs_app -C -d Dreamsoft_UAT -i scripts/add-getstatebookid-function.sql
IF OBJECT_ID('dbo.GetStateBookId') IS NOT NULL
    DROP FUNCTION dbo.GetStateBookId;
GO

CREATE FUNCTION [dbo].[GetStateBookId] (@GeographicalId AS bigint, @Type as nvarchar(5))
RETURNS Bigint AS
BEGIN
    DECLARE @BookId AS Bigint

    if(@Type='NC')
    BEGIN
        SELECT @BookId = Bookid from App_BookMaster where BookGroup='West' and BookType='AA' and BookAlias like '%NRI-Company%'
    END

    if(@Type='NI')
    BEGIN
        SELECT @BookId = Bookid from App_BookMaster where BookGroup='West' and BookType='AA' and BookAlias like '%NRI-Individual%'
    END

    ELSE

    BEGIN
        SELECT @BookId = Bookid from App_BookMaster
        outer Apply
        (
            Select GroupId as StateID from App_Geographical ST
            Where ST.GeographicalId=@GeographicalId
        )
        APS
        where ',' + GeographicalIds +',' like ('%,'+ CAST(APS.StateID as nvarchar)+',%')
        and( (@Type='I' and BookType='AA' and BookAlias like '%Individual%' and BookAlias not like '%NRI%')
        OR (@Type='C' and BookType='AA' and BookAlias like '%Company%' and BookAlias not like '%NRI%')
        OR (@Type='LH' and BookType='AA' and BookAlias like '%-Member%')
        OR (@Type='LHN' and BookType='AA' and BookAlias like '%-Non Member%')
        OR (@Type='NI' and BookType='AA' and BookAlias like '%NRI-Individual%')
        OR (@Type='NC' and BookType='AA' and BookAlias like '%NRI-Company%')
        OR (@Type='SC' and BookType='AA' and BookAlias like '%Self-Release%')
        OR (@Type='NSC' and BookType='AA' and BookAlias like '%NRI-Self Release%')
        OR (@Type='F' and BookType='FC' )
        OR ( BookType=@Type )
        )
    END
    IF @BookId =0
    BEGIN
        SET @BookId = null
    END

    RETURN @BookId
END
GO
