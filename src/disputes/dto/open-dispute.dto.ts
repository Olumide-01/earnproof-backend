import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class OpenDisputeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  reason!: string;
}