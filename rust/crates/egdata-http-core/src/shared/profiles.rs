//! Shared `profiles` helpers used by the versioned and unversioned surfaces.
use serde_json::{Value, json};

pub fn leaderboard_stages() -> Vec<Value> {
    vec![
        json!({"$project":{"epicAccountId":1,"sandboxId":1,"totalXP":1,"totalUnlocked":1,"playerAwards":1}}),
        json!({"$group":{"_id":{"player":"$epicAccountId","sandbox":"$sandboxId"},"xpForSandbox":{"$max":"$totalXP"},"unlockedForSandbox":{"$max":"$totalUnlocked"},"awardsForSandbox_arr":{"$push":"$playerAwards"}}}),
        json!({"$addFields":{"awardsForSandbox":{"$reduce":{"input":"$awardsForSandbox_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}),
        json!({"$project":{"awardsForSandbox_arr":0}}),
        json!({"$group":{"_id":"$_id.player","xpEarned":{"$sum":"$xpForSandbox"},"achievementsWon":{"$sum":"$unlockedForSandbox"},"awards_arr":{"$push":"$awardsForSandbox"}}}),
        json!({"$addFields":{"awards":{"$reduce":{"input":"$awards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}},"awardsEarned":{"$size":{"$reduce":{"input":"$awards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}}),
        json!({"$project":{"awards_arr":0}}),
        json!({"$addFields":{"awardsByType":{"$arrayToObject":{"$map":{"input":{"$setUnion":{"$map":{"input":"$awards","as":"a","in":"$$a.awardType"}}},"as":"type","in":{"k":"$$type","v":{"$size":{"$filter":{"input":"$awards","as":"a","cond":{"$eq":["$$a.awardType","$$type"]}}}}}}}}}}),
        json!({"$lookup":{"from":"epic","localField":"_id","foreignField":"accountId","as":"player"}}),
        json!({"$unwind":{"path":"$player","preserveNullAndEmptyArrays":true}}),
        json!({"$setWindowFields":{"sortBy":{"xpEarned":-1},"output":{"rank":{"$rank":{}}}}}),
        json!({"$project":{"_id":0,"rank":1,"accountId":"$_id","displayName":"$player.displayName","xpEarned":1,"achievementsWon":1,"awardsEarned":1,"awardsByType":1}}),
    ]
}

pub fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.,
        Value::Bool(b) => f64::from(i32::from(*b)),
        Value::Number(n) => n.as_f64().unwrap(),
        v => {
            let text = egdata_core::v1::serialization::js_string(v);
            crate::shared::system::js_string_number(&text)
        }
    }
}

pub fn rare_pipeline(filter: Value, limit: Option<u32>) -> Vec<Value> {
    let mut p = vec![
        json!({"$match":filter}),
        json!({"$unwind":"$playerAchievements"}),
        json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),
        json!({"$lookup":{"from":"achievementsets","let":{"setId":"$playerAchievements.playerAchievement.achievementSetId","name":"$playerAchievements.playerAchievement.achievementName"},"pipeline":[{"$match":{"$expr":{"$eq":["$achievementSetId","$$setId"]}}},{"$unwind":"$achievements"},{"$match":{"$expr":{"$eq":["$achievements.name","$$name"]}}},{"$project":{"_id":0,"sandboxId":1,"achievementSetId":1,"achievement":"$achievements"}}],"as":"achDoc"}}),
        json!({"$unwind":"$achDoc"}),
        json!({"$replaceRoot":{"newRoot":{"$mergeObjects":["$achDoc.achievement",{"sandboxId":"$achDoc.sandboxId","achievementSetId":"$achDoc.achievementSetId","unlocked":true,"unlockDate":"$playerAchievements.playerAchievement.unlockDate"}]}}}),
    ];
    if limit == Some(25) {
        p.extend([
            json!({"$group":{"_id":null,"rare25":{"$topN":{"n":25,"sortBy":{"completedPercent":1},"output":"$$ROOT"}}}}),
            json!({"$unwind":"$rare25"}),
            json!({"$replaceRoot":{"newRoot":"$rare25"}}),
            json!({"$lookup":{"from":"offers","let":{"sbx":"$sandboxId"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$namespace","$$sbx"]},{"$eq":["$offerType","BASE_GAME"]},{"$eq":["$isCodeRedemptionOnly",false]}]}}},{"$sort":{"isDisplayable":-1,"title":1,"lastModifiedDate":-1}},{"$limit":1},{"$project":{"_id":0,"id":1,"namespace":1,"keyImages":1,"title":1,"productSlug":1}}],"as":"offer"}}),
            json!({"$unwind":{"path":"$offer","preserveNullAndEmptyArrays":true}}),
        ]);
    } else if let Some(n) = limit {
        p.push(json!({"$sort":{"completedPercent":1}}));
        p.push(json!({"$limit":n}));
    }
    p
}
