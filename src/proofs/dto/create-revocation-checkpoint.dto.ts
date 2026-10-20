import { IsString, IsNotEmpty, Matches, IsISO8601 } from 'class-validator';

export class CreateRevocationCheckpointDto {
  @IsString()
  @IsNotEmpty()
  ledger: string;

  @IsString()
  @IsNotEmpty()
  contractIdentity: string;

  @IsString()
  @IsNotEmpty()
  algorithm: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'sequence must be a decimal number string' })
  sequence: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-f]+$/i, { message: 'root must be a valid hex string' })
  root: string;

  @IsISO8601()
  @IsNotEmpty()
  observedAt: string;
}

export class CreateRevocationCheckpointResponseDto {
  status: 'accepted' | 'quarantined';
  checkpoint: {
    id: string;
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
    status: string;
    quarantineReason?: string;
  };
  head: {
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
  };
}
