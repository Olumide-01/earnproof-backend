import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class StorageRefDto {
  @IsString()
  label!: string;

  @IsString()
  uri!: string;
}

export class SubmitManifestDto {
  @IsIn(["PROOF_OWNER", "ISSUER", "ADMIN", "VERIFIER"])
  submitterRole!: "PROOF_OWNER" | "ISSUER" | "ADMIN" | "VERIFIER";

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  algorithms!: string[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StorageRefDto)
  storageRefs!: StorageRefDto[];

  @IsOptional()
  @IsString()
  contractTransactionHash?: string;
}