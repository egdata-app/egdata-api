//! Mongo aggregation stages for the unversioned profile API.
use serde_json::{Value, json};

fn page_operand(value: f64) -> Value {
    // The Node BSON driver encodes small whole JS numbers as int32.
    if (i32::MIN as f64..=i32::MAX as f64).contains(&value) {
        json!(value as i32)
    } else {
        json!(value)
    }
}

pub(super) fn achievements(id: &str, skip: f64, limit: f64) -> Vec<Value> {
    let (skip, limit) = (page_operand(skip), page_operand(limit));
    vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$unwind":"$playerAchievements"}),
        json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),
        json!({"$addFields":{"unlockDate":"$playerAchievements.playerAchievement.unlockDate"}}),
        json!({"$group":{"_id":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"},"doc":{"$first":"$$ROOT"},"latestUnlockDate":{"$max":"$unlockDate"}}}),
        json!({"$replaceRoot":{"newRoot":"$doc"}}),
        json!({"$sort":{"unlockDate":-1}}),
        json!({"$lookup":{"from":"achievementsets","let":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"},"pipeline":[{"$match":{"$expr":{"$eq":["$sandboxId","$$sandboxId"]}}},{"$unwind":"$achievements"},{"$match":{"$expr":{"$eq":["$achievements.name","$$achievementName"]}}},{"$project":{"_id":0,"achievementDetails":"$achievements"}}],"as":"achievementDetails"}}),
        json!({"$unwind":{"path":"$achievementDetails","preserveNullAndEmptyArrays":false}}),
        json!({"$project":{"_id":0,"achievementName":"$playerAchievements.playerAchievement.achievementName","unlockDate":"$playerAchievements.playerAchievement.unlockDate","XP":"$playerAchievements.playerAchievement.XP","sandboxId":"$playerAchievements.playerAchievement.sandboxId","isBase":"$playerAchievements.playerAchievement.isBase","achievementDetails":"$achievementDetails.achievementDetails"}}),
        json!({"$skip":skip}),
        json!({"$limit":limit}),
    ]
}

pub(super) fn achievement_count(id: &str) -> Vec<Value> {
    vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$unwind":"$playerAchievements"}),
        json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),
        json!({"$group":{"_id":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"}}}),
        json!({"$count":"count"}),
    ]
}

pub(super) fn statistics(id: &str) -> Vec<Value> {
    vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$group":{"_id":"$sandboxId","playerAwards":{"$first":"$playerAwards"},"totalUnlocked":{"$first":"$totalUnlocked"},"totalXP":{"$first":"$totalXP"}}}),
        json!({"$group":{"_id":null,"totalGames":{"$sum":1},"totalPlayerAwards":{"$sum":{"$size":{"$ifNull":["$playerAwards",[]]}}},"totalAchievements":{"$sum":{"$ifNull":["$totalUnlocked",0]}},"totalXP":{"$sum":{"$ifNull":["$totalXP",0]}}}}),
    ]
}

pub(super) fn games(id: &str, platinum: bool, sort: &str, skip: f64, limit: f64) -> Vec<Value> {
    let (skip, limit) = (page_operand(skip), page_operand(limit));
    let mut pipeline = vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$group":{"_id":"$sandboxId","totalUnlocked":{"$max":"$totalUnlocked"},"totalXP":{"$max":"$totalXP"},"playerAwards_arr":{"$push":"$playerAwards"}}}),
        json!({"$addFields":{"playerAwards":{"$reduce":{"input":"$playerAwards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}),
        json!({"$project":{"playerAwards_arr":0}}),
    ];
    if platinum {
        pipeline.push(json!({"$match":{"$expr":{"$gt":[{"$size":"$playerAwards"},0]}}}));
    }
    pipeline.extend([
        json!({"$lookup":{"from":"offers","let":{"sbx":"$_id"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$namespace","$$sbx"]},{"$eq":["$offerType","BASE_GAME"]},{"$eq":["$isCodeRedemptionOnly",false]}]}}},{"$sort":{"isDisplayable":-1,"title":1,"lastModifiedDate":-1}},{"$limit":1},{"$project":{"_id":0,"id":1,"namespace":1,"keyImages":1,"title":1,"productSlug":1}}],"as":"offer"}}),
        json!({"$unwind":{"path":"$offer","preserveNullAndEmptyArrays":true}}),
        json!({"$lookup":{"from":"achievementsets","localField":"_id","foreignField":"sandboxId","as":"achievementSets"}}),
        json!({"$addFields":{"totalAchievements":{"$sum":{"$map":{"input":"$achievementSets","as":"s","in":{"$size":"$$s.achievements"}}}},"totalProductXP":{"$sum":{"$map":{"input":"$achievementSets","as":"s","in":{"$reduce":{"input":"$$s.achievements","initialValue":0,"in":{"$add":["$$value","$$this.xp"]}}}}}}}}),
        json!({"$addFields":{"productAchievements":{"totalAchievements":"$totalAchievements","totalProductXP":"$totalProductXP"},"completionPercentage":{"$cond":[{"$eq":["$totalAchievements",0]},0,{"$divide":["$totalUnlocked","$totalAchievements"]}]},"baseOfferForSandbox":{"id":"$offer.id","namespace":"$offer.namespace","keyImages":"$offer.keyImages"},"product":{"name":"$offer.title","slug":"$offer.productSlug"},"sandboxId":"$_id"}}),
        json!({"$project":{"_id":0,"offer":0,"achievementSets":0,"totalAchievements":0,"totalProductXP":0}}),
 ]);
    let order = match sort {
        "alphabetical" => json!({"product.name":1,"sandboxId":1}),
        "xp" => json!({"totalXP":-1,"product.name":1,"sandboxId":1}),
        "achievements" => json!({"totalUnlocked":-1,"product.name":1,"sandboxId":1}),
        _ => json!({"completionPercentage":-1,"product.name":1,"sandboxId":1}),
    };
    pipeline.extend([json!({"$sort":order}),json!({"$facet":{"paginated":[{"$skip":skip},{"$limit":limit}],"total":[{"$count":"value"}]}}),
        json!({"$addFields":{"total":{"$ifNull":[{"$arrayElemAt":["$total.value",0]},0]}}}),
 ]);
    pipeline
}
