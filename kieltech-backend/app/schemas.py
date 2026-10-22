import re
from typing import Optional, Literal, List
from pydantic import BaseModel, Field, field_validator, model_validator

ALLOWED_MODELS = [
    'kielmind-lite',
    'kielmind-pro',
    'kiellens-ocr',
    'kiellens-chat',
    'kielforge-fast',
    'kielforge-hd',
]


class ChatCompletionRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description='User prompt to respond to')
    conversation_id: Optional[str] = Field(default=None, max_length=120)
    context_message_id: Optional[int] = Field(default=None, ge=1)
    system_instructions: str = Field(default='You are a helpful assistant.', description='System instructions')
    stream: bool = Field(default=False, description='Enable streaming output')
    model: str = Field(default='kielmind-lite', min_length=1, max_length=128)
    temperature: float = Field(default=0.5, ge=0, le=2)
    max_tokens: int = Field(default=900, ge=1, le=8192)
    tools: Optional[List[dict]] = Field(default=None, description='Optional OpenAI-compatible tool schema for function calling')
    tool_choice: Optional[str | dict] = Field(default=None, description='Tool choice policy or specific tool selection')
    messages: Optional[List[dict]] = Field(default=None, description='Optional conversation history')

    @field_validator('prompt')
    @classmethod
    def validate_prompt(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('prompt cannot be empty')
        return value.strip()


class ChatImageSearchRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=160)
    conversation_id: Optional[str] = Field(default=None, max_length=120)

    @field_validator('query')
    @classmethod
    def validate_query(cls, value: str) -> str:
        normalized = value.strip()
        if len(normalized) < 2:
            raise ValueError('query must contain at least 2 characters')
        return normalized


class StudioAgentRequest(BaseModel):
    project_id: str = Field(..., min_length=1, max_length=120)
    prompt: str = Field(..., min_length=1, max_length=20_000)
    run_id: Optional[str] = Field(default=None, max_length=120)
    model: str = Field(default='kielmind-lite', min_length=1, max_length=120)
    history: List[dict] = Field(default_factory=list, max_length=40)
    context: List[dict] = Field(default_factory=list, max_length=40)
    max_steps: int = Field(default=50, ge=1, le=100)

    @field_validator('prompt')
    @classmethod
    def validate_agent_prompt(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('prompt cannot be empty')
        return value.strip()


class StudioConversationRequest(BaseModel):
    project_id: str = Field(..., min_length=1, max_length=120)
    prompt: str = Field(..., min_length=1, max_length=20_000)
    model: str = Field(default='kielmind-lite', min_length=1, max_length=120)
    history: List[dict] = Field(default_factory=list, max_length=20)

    @field_validator('prompt')
    @classmethod
    def validate_conversation_prompt(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('prompt cannot be empty')
        return value.strip()


class StudioModelAssignmentRequest(BaseModel):
    model_ids: List[str] = Field(default_factory=list, max_length=100)

    @field_validator('model_ids')
    @classmethod
    def validate_model_ids(cls, value: List[str]) -> List[str]:
        cleaned = [model_id.strip() for model_id in value]
        if any(not model_id or len(model_id) > 120 for model_id in cleaned):
            raise ValueError('model IDs must be between 1 and 120 characters')
        if len(set(cleaned)) != len(cleaned):
            raise ValueError('model IDs must be unique')
        return cleaned


class VisionAnalysisRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    conversation_id: Optional[str] = Field(default=None, max_length=120)
    context_message_id: Optional[int] = Field(default=None, ge=1)
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    model: str = Field(default='kiellens-ocr', min_length=1, max_length=128)

    @field_validator('image_url', 'image_base64')
    @classmethod
    def validate_image_input(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not value.strip():
            raise ValueError('image input cannot be empty')
        return value

    def model_dump(self, *args, **kwargs):
        return super().model_dump(*args, **kwargs)


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    size: str = Field(default='1024x1024')
    steps: int = Field(default=20, ge=1, le=100)
    model: str = Field(default='kielforge-fast', min_length=1, max_length=128)


class FirebaseGoogleSignInRequest(BaseModel):
    id_token: str = Field(..., min_length=1, max_length=8192)

    @field_validator('id_token')
    @classmethod
    def validate_id_token(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError('Firebase ID token is required.')
        return normalized


class ManagedModelCreateRequest(BaseModel):
    display_name: str = Field(..., min_length=2, max_length=120)
    model_id: str = Field(..., min_length=2, max_length=120)
    provider_model: Optional[str] = Field(default=None, min_length=2, max_length=128)
    category: Literal[
        'text-generation',
        'image-understanding',
        'image-generation',
        'multimodal',
        'voice',
        'video-generation',
        'embeddings',
    ]
    type_label: Optional[str] = Field(default=None, min_length=1, max_length=80)
    modalities: List[Literal['text-generation', 'image-understanding', 'image-generation']] = Field(default_factory=list, max_length=3)
    input_price: Optional[float] = Field(default=None, ge=0, le=1_000_000)
    cache_price: float = Field(default=0, ge=0, le=1_000_000)
    output_price: Optional[float] = Field(default=None, ge=0, le=1_000_000)
    max_context: Optional[int] = Field(default=None, ge=1, le=2_000_000)

    @model_validator(mode='after')
    def validate_modalities(self):
        capabilities = set(self.modalities)
        if len(capabilities) != len(self.modalities):
            raise ValueError('Model capabilities cannot contain duplicates.')
        text_and_vision = {'text-generation', 'image-understanding'}
        text_image_and_vision = {'text-generation', 'image-generation', 'image-understanding'}
        if self.category == 'multimodal' and capabilities not in {frozenset(text_and_vision), frozenset(text_image_and_vision)}:
            raise ValueError('Choose either Text + Vision or Text + Image + Vision for a multimodal model.')
        if self.category != 'multimodal' and capabilities:
            raise ValueError('Capability tags are only configurable for multimodal models.')
        if self.category != 'multimodal' and self.type_label is not None:
            raise ValueError('Model type labels are only configurable for multimodal models.')
        configured_fields = (self.provider_model, self.input_price, self.output_price, self.max_context)
        if any(value is not None for value in configured_fields) and not all(value is not None for value in configured_fields):
            raise ValueError('Provider endpoint, input/output rates, and max context must be configured together.')
        return self

    @field_validator('display_name', 'model_id', 'provider_model')
    @classmethod
    def validate_model_strings(cls, value: Optional[str], info) -> Optional[str]:
        if value is None and info.field_name == 'provider_model':
            return None
        if value is None:
            raise ValueError(f'{info.field_name} cannot be empty')
        normalized = value.strip()
        if not normalized:
            raise ValueError(f'{info.field_name} cannot be empty')
        if info.field_name == 'model_id' and not re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,119}', normalized):
            raise ValueError('Model ID must be a lowercase slug using letters, numbers, dots, underscores, or hyphens.')
        if info.field_name == 'provider_model' and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}', normalized):
            raise ValueError('Provider model ID contains unsupported characters.')
        return normalized

    @field_validator('type_label')
    @classmethod
    def validate_type_label(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError('Model type label cannot be empty.')
        return normalized


class ManagedModelChatAvailabilityRequest(BaseModel):
    is_chat_available: bool
    chat_capability: Optional[str] = Field(default=None, min_length=2, max_length=60)

    @field_validator('chat_capability')
    @classmethod
    def validate_chat_capability(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError('Model ability cannot be empty.')
        return normalized

    @model_validator(mode='after')
    def require_chat_capability_when_assigned(self):
        if self.is_chat_available and not self.chat_capability:
            raise ValueError('Model ability is required when making a model available in Kiel Chat.')
        return self


class TokenCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, description='Token name or description')
    owner_email: Optional[str] = Field(default=None, description='Owner email for administrative attribution')


class TokenCreateResponse(BaseModel):
    token: str


class TokenInfo(BaseModel):
    id: str
    name: str
    masked: str
    created_at: str
    last_used_at: Optional[str] = None
    active: bool
    owner_email: Optional[str] = None


class TokenListResponse(BaseModel):
    tokens: List[TokenInfo]


class TokenRevokeRequest(BaseModel):
    id: str = Field(..., description='Token ID to revoke')


class BillingInitializeRequest(BaseModel):
    email: str = Field(..., min_length=3, description='Customer email for the payment')
    plan_code: str = Field(default='wallet-topup', min_length=1, description='Paystack plan code or internal plan identifier')
    amount: float = Field(..., ge=0.01, description='Wallet top-up amount in USD')
    amount_usd: Optional[float] = Field(default=None, ge=0.01, description='Wallet top-up amount in USD')
    currency: str = Field(default='NGN', min_length=1, max_length=3, description='Currency code such as NGN or USD')
    callback_url: Optional[str] = Field(default=None, description='Optional callback URL for the checkout redirect')


class BillingInitializeResponse(BaseModel):
    status: str
    message: str
    reference: str
    email: str
    plan_code: str
    amount: float
    amount_usd: Optional[float] = None
    amount_ngn: Optional[float] = None
    exchange_rate: Optional[float] = None
    currency: str
    payment_status: str
    provider: str
    authorization_url: Optional[str] = None
    access_code: Optional[str] = None
    exchange_rate_source: Optional[str] = None


class BillingUsageResponse(BaseModel):
    current_usage: int
    included_limit: int
    overage_mode: bool
    overage_price: float
    period_start: str
    period_end: str
    usage_history: List[dict] = Field(default_factory=list)
    payment_status: str = 'pending'
    next_invoice_amount: int = 0


class BillingConfigRequest(BaseModel):
    paystack_secret_key: Optional[str] = None
    paystack_public_key: Optional[str] = None
    paystack_enabled: Optional[bool] = None
    default_plan_code: Optional[str] = None
    default_amount: Optional[int] = Field(default=None, ge=1)
    usd_to_ngn_rate: Optional[float] = Field(default=None, gt=0)


class BillingConfigResponse(BaseModel):
    paystack_enabled: bool
    default_plan_code: str
    default_amount: int
    paystack_webhook_url: str
    paystack_callback_url: str
    paystack_public_key: str
    usd_to_ngn_rate: float


class BillingHistoryResponse(BaseModel):
    items: List[dict]


class DownloadItem(BaseModel):
    id: int
    title: str
    description: str
    file_url: str
    file_size: Optional[int] = None
    file_sha256: Optional[str] = None
    downloads_count: int = 0
    created_at: Optional[str] = None


class DownloadListResponse(BaseModel):
    downloads: List[DownloadItem]


class RatingCreateRequest(BaseModel):
    item_id: int = Field(..., ge=1)
    rating: int = Field(..., ge=1, le=5)


class RatingItem(BaseModel):
    item_id: int
    rating: int
    created_at: str


class RatingListResponse(BaseModel):
    ratings: List[RatingItem]


class StudioDeploymentCreateRequest(BaseModel):
    website_name: str = Field(..., min_length=1, max_length=120)
    deployment_target: str = Field(default='kieltech-preview', min_length=1, max_length=40)
    custom_domain: Optional[str] = Field(default=None, max_length=200)
    files: List[dict] = Field(default_factory=list)

    @field_validator('website_name', 'deployment_target', 'custom_domain')
    @classmethod
    def validate_deployment_text_fields(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('value cannot be empty')
        if re.search(r'<[^>]+>', cleaned):
            raise ValueError('unsafe content detected')
        return cleaned


class StudioPreviewCreateRequest(BaseModel):
    page_path: str = Field(default='index.html', min_length=1, max_length=240)
    files: List[dict] = Field(default_factory=list)

class StudioProjectCreateRequest(BaseModel):
    project_name: str = Field(default='KielTech Studio project', min_length=1, max_length=120)


class StudioFileActionRequest(BaseModel):
    action: Literal['create_file', 'update_file', 'delete_file']
    path: str = Field(..., min_length=1, max_length=400)
    content: Optional[str] = None


class StudioFileActionBatchRequest(BaseModel):
    actions: List[StudioFileActionRequest] = Field(..., min_length=1, max_length=1000)


class StudioChatMessageRequest(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(..., min_length=1, max_length=100_000)
    author: Optional[str] = None


class WebDevelopmentRequestCreate(BaseModel):
    email: str = Field(..., min_length=3)
    project_name: str = Field(..., min_length=1, max_length=120)
    project_brief: str = Field(..., min_length=20)
    selected_ai: str = Field(..., min_length=1, max_length=80)
    selected_ai_category: str = Field(..., min_length=1, max_length=40)
    selected_ai_price: str = Field(default='$0', max_length=20)
    selected_ai_model: str = Field(default='kielmind-lite', max_length=80)
    delivery_preference: str = Field(default='publish')
    deployment_target: str = Field(default='free-hosting')
    feature_list: str = Field(default='', max_length=500)

    @field_validator('email')
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', normalized):
            raise ValueError('email must be a valid email address')
        return normalized

    @field_validator('project_name', 'selected_ai', 'selected_ai_category')
    @classmethod
    def validate_text_fields(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('value cannot be empty')
        if len(cleaned) > 120 and 'project_name' in value:
            raise ValueError('project_name is too long')
        if re.search(r'<[^>]+>', cleaned):
            raise ValueError('unsafe content detected')
        return cleaned

    @field_validator('project_brief', 'feature_list')
    @classmethod
    def validate_content_fields(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('value cannot be empty')
        if re.search(r'<[^>]+>', cleaned):
            raise ValueError('unsafe content detected')
        return cleaned


class WebDevelopmentRequestItem(BaseModel):
    id: int
    email: str
    project_name: str
    project_brief: str
    selected_ai: str
    selected_ai_category: str
    selected_ai_price: str
    delivery_preference: str
    deployment_target: str
    feature_list: str
    status: str
    review_status: Optional[str] = 'pending'
    review_note: Optional[str] = None
    notification_state: Optional[str] = 'received'
    created_at: str


class WebDevelopmentRequestListResponse(BaseModel):
    requests: List[WebDevelopmentRequestItem]
    count: int


class WebDevelopmentRequestStatusUpdate(BaseModel):
    status: str = Field(..., min_length=1)


class WebDevelopmentRequestDeliveryRequest(BaseModel):
    action: str = Field(default='download', min_length=1)


class WebDevelopmentRequestRetryRequest(BaseModel):
    action: str = Field(default='download', min_length=1)


class WebDevelopmentBillingCheckoutRequest(BaseModel):
    amount: float = Field(..., gt=0, description='Amount due for the project billing milestone')
    currency: str = Field(default='USD', min_length=1, max_length=3)
    payment_type: str = Field(default='deposit', min_length=1, max_length=20)
    reference: Optional[str] = Field(default=None, description='Optional external reference for the checkout')
    invoice_id: Optional[str] = None
    note: Optional[str] = None


class WebDevelopmentBillingEventRequest(BaseModel):
    event: str = Field(..., min_length=1)
    status: str = Field(default='pending', min_length=1)
    amount: Optional[float] = Field(default=None, ge=0)
    currency: str = Field(default='USD', min_length=1, max_length=3)
    reference: Optional[str] = None
    invoice_id: Optional[str] = None
    note: Optional[str] = None


class WebDevelopmentBillingStatusResponse(BaseModel):
    request_id: int
    payment_status: str
    payment_type: str
    amount_total: float
    amount_paid: float
    amount_due: float
    refund_amount: float
    currency: str
    invoice_id: Optional[str] = None
    invoice_status: Optional[str] = None
    reference: Optional[str] = None
    last_event: Optional[str] = None


class ErrorResponse(BaseModel):
    error: str
    detail: str
