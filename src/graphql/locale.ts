import { GraphQLError } from "graphql";
import {
  isInvalidLocaleError,
  parseLocale,
} from "../utils/offer-localization.js";

type LocaleArgs = {
  locale?: string | null;
};

type LocalizedParent = {
  locale?: string | null;
};

export function resolveGraphqlLocale(
  args?: LocaleArgs | null,
  parent?: LocalizedParent | null,
) {
  try {
    return parseLocale(args?.locale ?? parent?.locale);
  } catch (error) {
    if (isInvalidLocaleError(error)) {
      throw new GraphQLError(error.message, {
        extensions: {
          code: "BAD_USER_INPUT",
          argumentName: "locale",
        },
      });
    }

    throw error;
  }
}

export function withOfferLocalizationProjection<
  T extends Record<string, unknown>,
>(projection: T) {
  return {
    ...projection,
    id: 1,
    namespace: 1,
  };
}
