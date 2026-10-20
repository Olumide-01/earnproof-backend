import { SetMetadata } from "@nestjs/common";
import {
  API_DEPRECATION_METADATA,
  ApiDeprecationPolicy,
} from "./api-deprecation";

export const ApiDeprecation = (
  policy: ApiDeprecationPolicy,
): MethodDecorator =>
  SetMetadata(API_DEPRECATION_METADATA, policy);
