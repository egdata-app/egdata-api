export const typeDefs = `#graphql
    scalar Date
    scalar JSON

    type Query {
        # Offers
        offer(id: ID!): Offer
        offers(limit: Int, page: Int, country: String): OfferConnection
        upcoming(limit: Int, page: Int, country: String): OfferConnection
        latestReleased(limit: Int, page: Int, country: String): OfferConnection
        topSellers(limit: Int, page: Int): OfferConnection
        topWishlisted(limit: Int, page: Int): OfferConnection
        featuredDiscounts(country: String): [Offer]

        # Items
        item(id: ID!): Item
        items(limit: Int, page: Int): ItemConnection

        # Sandboxes
        sandbox(id: ID!): Sandbox
        sandboxes(limit: Int, page: Int): SandboxConnection

        # Misc
        build(id: ID!): Build
        builds(limit: Int, page: Int, sortBy: String, sortDir: String): [Build]
        changelog(id: ID!): Changelog
        events: [Tag]
        event(id: ID!, limit: Int, page: Int, country: String): OfferConnection
        genres: [GenreResult]
        latestAchievements(country: String): [Offer]
    }

    type GenreResult {
        genre: Tag
        offers: [GenreOffer]
    }

    type GenreOffer {
        id: String
        title: String
        image: KeyImage
    }

    type OfferConnection {
        elements: [Offer]
        total: Int
        page: Int
        limit: Int
        count: Int # Alias for total in some contexts
    }

    type ItemConnection {
        elements: [Item]
        total: Int
        page: Int
        limit: Int
    }

    type SandboxConnection {
        elements: [Sandbox]
        total: Int
        page: Int
        limit: Int
    }

    type OfferMappings {
        pageSlug: String
        pageType: String
        _id: String
    }

    type CustomAttribute {
        key: String
        value: String
        type: String
        _id: ID
    }

    type Tag {
        id: String
        name: String
        groupName: String
    }

    type Seller {
        id: String
        name: String
    }

    type KeyImage {
        type: String
        url: String
        md5: String
    }

    type Price {
        country: String
        region: String
        namespace: String
        offerId: String
        price: SinglePrice
        appliedRules: [AppliedRule]
        updatedAt: Date
    }

    type SinglePrice {
        currencyCode: String
        discount: Float
        discountPrice: Float
        originalPrice: Float
        basePayoutCurrencyCode: String
        basePayoutPrice: Float
        payoutCurrencyExchangeRate: Float
    }

    type AppliedRule {
        id: String
        name: String
        namespace: String
        promotionStatus: String
        startDate: Date
        endDate: Date
        saleType: String
        regionIds: [String]
    }

    type Asset {
        _id: String
        artifactId: String
        downloadSizeBytes: Float
        installedSizeBytes: Float
        itemId: String
        namespace: String
        platform: String
        title: String
        updatedAt: Date
    }

    type Build {
        _id: String
        appName: String
        labelName: String
        buildVersion: String
        hash: String
        metadata: BuildMetadata
        downloadSizeBytes: Float
        installedSizeBytes: Float
        createdAt: Date
        updatedAt: Date
        technologies: [Technology]
        items: [Item]
        files(limit: Int, page: Int, sort: String, dir: String, q: String, extension: String): FileConnection
        installOptions: JSON
    }

    type FileConnection {
        elements: [File]
        total: Int
        page: Int
        limit: Int
    }

    type File {
        fileName: String
        fileSize: Float
        fileHash: String
        manifestHash: String
        depth: Int
        installTags: [String]
    }

    type BuildMetadata {
        installationPoolId: String
    }

    type Technology {
        section: String
        technology: String
    }

    type Changelog {
        _id: ID
        metadata: ChangelogMetadata
        timestamp: Date
        document: ChangelogDocument
    }

    type ChangelogMetadata {
        contextId: String
        contextType: String
        changes: [ChangelogChange]
    }

    type ChangelogChange {
        changeType: String
        field: String
        before: JSON
        after: JSON
    }

    union ChangelogDocument = Offer | Item | Asset | Build

    type Item {
        _id: String
        id: String
        namespace: String
        title: String
        description: String
        keyImages: [KeyImage]
        categories: [ItemCategory]
        status: String
        creationDate: Date
        lastModifiedDate: Date
        customAttributes: [CustomAttribute]
        entitlementName: String
        entitlementType: String
        itemType: String
        releaseInfo: [ReleaseInfo]
        developer: String
        developerId: String
        eulaIds: [String]
        endOfSupport: Boolean
        applicationId: String
        unsearchable: Boolean
        requiresSecureAccount: Boolean
        offers: [Offer]
        assets: [Asset]
        builds: [Build]
        changelog(limit: Int, page: Int): ChangelogConnection
        mainOffer: Offer
    }

    type ItemCategory {
        path: String
    }

    type ReleaseInfo {
        id: String
        appId: String
        platform: [String]
    }

    type Sandbox {
        _id: ID
        name: String
        namespace: String
        parent: String
        ageGatings: JSON
        updated: Date
        items(limit: Int, page: Int): ItemConnection
        offers(limit: Int, page: Int): OfferConnection
        assets(limit: Int, page: Int, platform: String): AssetConnection
        builds(limit: Int, page: Int, platform: String): BuildConnection
        baseGame(country: String): BaseGameResult
        achievements: [AchievementSet]
        stats: SandboxStats
        changelog(limit: Int, page: Int): ChangelogConnection
    }

    type AssetConnection {
        elements: [Asset]
        total: Int
        page: Int
        limit: Int
        count: Int
    }

    type BuildConnection {
        elements: [Build]
        total: Int
        page: Int
        limit: Int
        count: Int
    }

    union BaseGameResult = Offer | Item

    type SandboxStats {
        offers: Int
        items: Int
        assets: Int
        builds: Int
        achievements: Int
    }

    type AchievementSet {
        _id: ID
        sandboxId: String
        isBase: Boolean
        achievements: [Achievement]
    }

    type Achievement {
        id: ID
        name: String
        description: String
        unlockedIcon: String
        lockedIcon: String
        rarity: String
        score: Int
    }

    type Franchise {
        _id: ID
        id: String
        name: String
        offers: [String]
        allOffers: [Offer]
    }

    type Giveaway {
        _id: ID
        id: String
        namespace: String
        startDate: Date
        endDate: Date
    }

    type Poll {
        _id: ID
        options: [PollOption]
    }

    type PollOption {
        id: String
        name: String
        votes: Int
    }

    type Rating {
        _id: ID
        overallScore: Float
        recommendedPercentage: Float
        totalReviews: Int
    }

    type Hltb {
        _id: ID
        hltbId: String
        name: String
        main: Float
        mainExtra: Float
        completionist: Float
    }

    type Offer {
        _id: String
        id: String
        namespace: String
        title: String
        description: String
        longDescription: String
        offerType: String
        effectiveDate: Date
        creationDate: Date
        lastModifiedDate: Date
        isCodeRedemptionOnly: Boolean
        productSlug: String
        urlSlug: String
        url: String
        developerDisplayName: String
        publisherDisplayName: String
        prePurchase: Boolean
        releaseDate: Date
        pcReleaseDate: Date
        viewableDate: Date
        countriesBlacklist: [String]
        countriesWhitelist: [String]
        refundType: String
        offerMappings: [OfferMappings]
        categories: [String]
        customAttributes: [CustomAttribute]
        items: [Item]
        tags: [Tag]
        seller: Seller
        keyImages: [KeyImage]
        price(country: String): Price
        changelog(limit: Int, page: Int): ChangelogConnection
        franchises: [Franchise]
        giveaways: [Giveaway]
        related(country: String): [Offer]
        suggestions(country: String): [Offer]
        ratings: Rating
        polls: Poll
        hltb: Hltb
        sandbox: Sandbox
        positions: JSON # Map of collectionId -> position
        ageRating(country: String): JSON
        features: OfferFeatures
    }

    type OfferFeatures {
        launcher: String
        features: [String]
        epicFeatures: [String]
    }

    type ChangelogConnection {
        elements: [Changelog]
        totalCount: Int
        totalPages: Int
        hasNextPage: Boolean
        hasPreviousPage: Boolean
    }
`;
